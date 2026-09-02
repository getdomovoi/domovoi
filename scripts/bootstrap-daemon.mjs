import { createHash } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { bootstrapPlan, verifyDownload } from "./bootstrap-plan.mjs"

const defaultMaximumBytes = 256 * 1024 * 1024

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

async function readBounded(response, url, maximumBytes) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${url} is larger than ${maximumBytes} bytes`)
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks = []
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      if (read > maximumBytes) throw new Error(`${url} is larger than ${maximumBytes} bytes`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export async function downloadOverHttps(url, {
  maximumBytes,
  fetch: fetchImpl = fetch,
  maximumRedirects = defaultMaximumRedirects,
}) {
  let current = httpsUrl(url).href
  for (let hop = 0; hop <= maximumRedirects; hop += 1) {
    const response = await fetchImpl(current, { redirect: "manual" })
    if (!redirectStatuses.has(response.status)) {
      if (!response.ok) throw new Error(`${current} answered ${response.status}`)
      return await readBounded(response, current, maximumBytes)
    }

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

export async function bootstrapDaemon({
  version,
  baseUrl,
  destination,
  download,
  maximumBytes = defaultMaximumBytes,
}) {
  const plan = bootstrapPlan({ version, baseUrl })
  const fetchBytes = download ?? ((url) => downloadOverHttps(url, { maximumBytes }))

  const manifest = String(await fetchBytes(plan.checksumUrl))
  const bytes = Buffer.from(await fetchBytes(plan.archiveUrl))
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${plan.archive} is larger than ${maximumBytes} bytes`)
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex")
  verifyDownload({ file: plan.archive, manifest, digest: sha256 })

  const release = join(destination, `v${plan.version}`)
  const path = join(release, plan.archive)
  const staging = `${path}.partial`
  await mkdir(release, { recursive: true })
  try {
    await writeFile(staging, bytes, { mode: 0o600 })
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }

  return { version: plan.version, path, sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, baseUrl, destination] = process.argv.slice(2)
  const result = await bootstrapDaemon({
    version,
    baseUrl,
    destination: destination ?? join(dirname(fileURLToPath(import.meta.url)), "..", "release"),
  })
  console.log(JSON.stringify(result, null, 2))
}
