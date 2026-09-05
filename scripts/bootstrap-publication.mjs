import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { link, lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const defaultPublicationTimeoutMs = 30_000

// This budget covers publication only. Download deadlines are a separate audit
// item. Start before filesystem work, never renew it during cleanup, and check
// the clock at settlement so a late filesystem result cannot start another step.
function publicationDeadline(timeoutMs, path) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Bootstrap publication timeout must be a positive integer at most 2147483647 ms")
  }
  const expiresAt = performance.now() + timeoutMs
  const controller = new AbortController()
  const timeout = new Error(`Bootstrap publication exceeded ${timeoutMs} ms; inspect ${path} before retrying because publication may have completed`)
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
  const check = () => {
    if (performance.now() >= expiresAt) controller.abort(timeout)
    controller.signal.throwIfAborted()
  }
  return {
    signal: controller.signal,
    check,
    clear: () => clearTimeout(timer),
    run: (operation) => new Promise((resolve, reject) => {
      check()
      const abort = () => { detach(); reject(controller.signal.reason) }
      const detach = () => controller.signal.removeEventListener("abort", abort)
      controller.signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => { check(); return operation() }).then((value) => {
        check()
        resolve(value)
      }).catch(reject).finally(detach)
    }),
  }
}

async function verifyPublishedArchive(path, bytes, sha256, deadline) {
  const info = await deadline.run(() => lstat(path))
  // Do not follow an existing symlink or read an unbounded pre-existing file.
  if (!info.isFile() || info.size !== bytes.length) {
    throw new Error(`${path} already exists with different bytes or is not a regular file; expected sha256 ${sha256}. Nothing was replaced`)
  }
  const hash = createHash("sha256")
  deadline.check()
  const stream = createReadStream(path, {
    end: bytes.length, highWaterMark: 64 * 1024, signal: deadline.signal,
  })
  let count = 0
  try {
    const iterator = stream[Symbol.asyncIterator]()
    for (;;) {
      const { value, done } = await deadline.run(() => iterator.next())
      if (done) break
      count += value.length
      hash.update(value)
    }
  } finally { stream.destroy() }
  if (count !== bytes.length || hash.digest("hex") !== sha256) {
    throw new Error(`${path} already exists with different bytes; expected sha256 ${sha256}. Nothing was replaced`)
  }
}

export async function publishBootstrapArchive({ release, path, bytes, sha256, timeoutMs }) {
  const deadline = publicationDeadline(timeoutMs, path)
  let directory
  let verified = false
  let failure
  try {
    await deadline.run(() => mkdir(release, { recursive: true }))
    await deadline.run(async () => { directory = await mkdtemp(join(release, ".bootstrap-")) })
    const staging = join(directory, "archive.partial")
    await deadline.run(() => writeFile(staging, bytes, {
      flag: "wx", mode: 0o600, flush: true, signal: deadline.signal,
    }))
    try {
      // A hard link publishes an already complete file without replacement.
      // Unique private staging plus immutable publication needs no shared lock.
      // Never fall back to rename/copy: either would restore the overwrite race.
      await deadline.run(() => link(staging, path))
    } catch (error) {
      if (deadline.signal.aborted) throw error
      if (error.code !== "EEXIST") {
        throw new Error(`Could not publish ${path} without replacement. ${error.message}`, { cause: error })
      }
    }
    await verifyPublishedArchive(path, bytes, sha256, deadline)
    verified = true
  } catch (error) { failure = error }

  try {
    if (directory) {
      // Only this invocation's private directory is eligible for cleanup.
      // No recursive deletion, legacy .partial cleanup, or final-archive unlink.
      await deadline.run(() => rm(join(directory, "archive.partial"), { force: true }))
      await deadline.run(() => rmdir(directory))
    }
  } catch (cleanup) {
    const outcome = verified ? `Archive verified at ${path}, but staging cleanup failed`
      : `Bootstrap did not finish; inspect ${path} before retrying`
    const message = `${outcome}. Retained staging may remain at ${directory}. ${failure?.message ?? cleanup.message}`
    failure = new AggregateError(failure ? [failure, cleanup] : [cleanup], message)
  } finally { deadline.clear() }
  if (failure) throw failure
}
