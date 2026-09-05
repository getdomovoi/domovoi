import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { bootstrapDeadline, validateBootstrapTimeout } from "./bootstrap-deadline.mjs"
import { bootstrapPlan, pinnedSha256, verifyDownload } from "./bootstrap-plan.mjs"
import { defaultPublicationTimeoutMs, publishBootstrapArchive } from "./bootstrap-publication.mjs"

const defaultMaximumBytes = 256 * 1024 * 1024
export const maximumManifestBytes = 256 * 1024
const defaultBootstrapTimeoutMs = 300_000

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const defaultMaximumRedirects = 5

function httpsUrl(url, base) {
  let parsed
  try {
    parsed = base === undefined ? new URL(url) : new URL(url, base)
  } catch {
    throw new Error(`${JSON.stringify(url)} is not a url that downloads over https`)
  }
  if (parsed.protocol !== "https:") throw new Error(`${parsed.href} is not https`)
  return parsed
}

function byteLimit(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("Bootstrap byte limit must be a non-negative safe integer")
  }
}

async function* readBounded(response, url, maximumBytes, deadline) {
  let reader
  let read = 0
  let finished = false
  const abort = () => {
    // Cancellation is a notification, not a new wait after expiry. Consume its
    // rejection without waiting for an uncooperative underlying source to close.
    reader.cancel(deadline.signal.reason).catch(() => {})
  }
  try {
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new Error(`${url} is larger than ${maximumBytes} bytes`)
    }
    if (!response.body) return
    deadline.check()
    reader = response.body.getReader()
    deadline.signal.addEventListener("abort", abort, { once: true })
    for (;;) {
      const { done, value } = await deadline.run(() => reader.read())
      if (done) { finished = true; break }
      read += value.byteLength
      if (read > maximumBytes) throw new Error(`${url} is larger than ${maximumBytes} bytes`)
      yield value
    }
  } finally {
    // fetch receives the same abort signal. Do not let cancellation of a
    // hostile response body extend the operation's budget.
    if (!finished) {
      await deadline.run(() => reader ? reader.cancel() : response.body?.cancel()).catch(() => {})
    }
    deadline.signal.removeEventListener("abort", abort)
    reader?.releaseLock()
  }
}

export async function* downloadOverHttps(url, {
  maximumBytes,
  fetch: fetchImpl = fetch,
  maximumRedirects = defaultMaximumRedirects,
  deadline,
}) {
  byteLimit(maximumBytes)
  if (!Number.isSafeInteger(maximumRedirects) || maximumRedirects < 0) {
    throw new Error("Bootstrap redirect limit must be a non-negative safe integer")
  }
  let current = httpsUrl(url).href
  for (let hop = 0; hop <= maximumRedirects; hop += 1) {
    const response = await deadline.run(async () => {
      const received = await fetchImpl(current, { redirect: "manual", signal: deadline.signal })
      try { deadline.check() } catch (error) {
        // Native fetch obeys abort, but an injected transport may settle late.
        // Release those bytes without letting a late result start body reads.
        received.body?.cancel(error).catch(() => {})
        throw error
      }
      return received
    })
    if (!redirectStatuses.has(response.status)) {
      if (!response.ok) {
        await deadline.run(() => response.body?.cancel()).catch(() => {})
        throw new Error(`${current} answered ${response.status}`)
      }
      yield* readBounded(response, current, maximumBytes, deadline)
      return
    }

    await deadline.run(() => response.body?.cancel())
    const location = response.headers.get("location")
    if (!location) throw new Error(`${current} redirected with no destination`)
    let next
    try {
      next = httpsUrl(location, current)
    } catch {
      throw new Error(`${current} redirected to ${location}, which is not https`)
    }
    current = next.href
  }
  throw new Error(`${url} redirected more than ${maximumRedirects} times`)
}

async function* downloadChunks(download, url, maximumBytes, deadline) {
  const source = await deadline.run(() => download(url, { maximumBytes, deadline }))
  // Buffer-returning injected downloaders remain useful for small fixtures.
  // Production always supplies the streamed HTTPS iterator, never full bytes.
  if (source instanceof Uint8Array || typeof source === "string") {
    const bytes = typeof source === "string" ? Buffer.from(source) : source
    if (bytes.byteLength > maximumBytes) throw new Error(`${url} is larger than ${maximumBytes} bytes`)
    yield bytes
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  let finished = false
  let size = 0
  try {
    for (;;) {
      const { done, value } = await deadline.run(() => iterator.next())
      if (done) { finished = true; break }
      if (!(value instanceof Uint8Array)) throw new Error(`${url} returned a non-byte chunk`)
      size += value.byteLength
      if (size > maximumBytes) throw new Error(`${url} is larger than ${maximumBytes} bytes`)
      yield value
    }
  } finally {
    if (!finished) await deadline.run(() => iterator.return?.()).catch(() => {})
  }
}

export async function bootstrapDaemon({
  version,
  baseUrl,
  destination,
  expectedSha256,
  download,
  maximumBytes = defaultMaximumBytes,
  publicationTimeoutMs = defaultPublicationTimeoutMs,
  timeoutMs = defaultBootstrapTimeoutMs,
}) {
  const plan = bootstrapPlan({ version, baseUrl })
  const pinned = pinnedSha256(expectedSha256)
  byteLimit(maximumBytes)
  validateBootstrapTimeout(publicationTimeoutMs)
  const release = join(destination, `v${plan.version}`)
  const path = join(release, plan.archive)
  const deadline = bootstrapDeadline(timeoutMs,
    `Bootstrap exceeded ${timeoutMs} ms for ${plan.archiveUrl}; inspect ${path} before retrying because publication may have completed`)
  const fetchChunks = download ?? downloadOverHttps
  try {
    // Only this small, separately bounded text file is accumulated in memory.
    const decoder = new TextDecoder()
    let manifest = ""
    for await (const chunk of downloadChunks(fetchChunks, plan.checksumUrl, maximumManifestBytes, deadline)) {
      manifest += decoder.decode(chunk, { stream: true })
    }
    manifest += decoder.decode()

    const hash = createHash("sha256")
    let byteLength = 0
    async function* archiveChunks() {
      for await (const chunk of downloadChunks(fetchChunks, plan.archiveUrl, maximumBytes, deadline)) {
        byteLength += chunk.byteLength
        hash.update(chunk)
        yield chunk
      }
    }
    const verify = () => {
      const sha256 = hash.digest("hex")
      verifyDownload({ file: plan.archive, manifest, digest: sha256 })
      if (sha256 !== pinned) {
        throw new Error(`${plan.archive} does not match the sha256 the caller pinned: expected ${pinned}, downloaded ${sha256}`)
      }
      return { byteLength, sha256 }
    }
    const { sha256 } = await publishBootstrapArchive({
      release, path, source: archiveChunks(), verify, deadline, timeoutMs: publicationTimeoutMs,
    })
    return { version: plan.version, path, sha256 }
  } finally { deadline.clear() }
}

const usage = "Usage: node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>\n"

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, baseUrl, destination, expectedSha256] = process.argv.slice(2)
  if (expectedSha256 === undefined) {
    process.stderr.write(usage)
    process.exitCode = 1
  } else {
    const result = await bootstrapDaemon({ version, baseUrl, destination, expectedSha256 })
    console.log(JSON.stringify(result, null, 2))
  }
}
