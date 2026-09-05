import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { link, lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { bootstrapDeadline, validateBootstrapTimeout } from "./bootstrap-deadline.mjs"

export const defaultPublicationTimeoutMs = 30_000

async function verifyPublishedArchive(path, byteLength, sha256, deadline) {
  const info = await deadline.run(() => lstat(path))
  // Do not follow an existing symlink or read an unbounded pre-existing file.
  if (!info.isFile() || info.size !== byteLength) {
    throw new Error(`${path} already exists with different bytes or is not a regular file; expected sha256 ${sha256}. Nothing was replaced`)
  }
  const hash = createHash("sha256")
  deadline.check()
  const stream = createReadStream(path, {
    end: byteLength, highWaterMark: 64 * 1024, signal: deadline.signal,
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
  if (count !== byteLength || hash.digest("hex") !== sha256) {
    throw new Error(`${path} already exists with different bytes; expected sha256 ${sha256}. Nothing was replaced`)
  }
}

export async function publishBootstrapArchive({ release, path, source, verify, deadline, timeoutMs }) {
  validateBootstrapTimeout(timeoutMs)
  let publication
  let active = deadline
  let directory
  let verified = false
  let failure
  let metadata
  try {
    await deadline.run(() => mkdir(release, { recursive: true }))
    await deadline.run(async () => { directory = await mkdtemp(join(release, ".bootstrap-")) })
    const staging = join(directory, "archive.partial")
    // writeFile consumes an async iterable with backpressure, then fsyncs and
    // closes before it resolves. No archive-sized buffer or second file copy.
    await deadline.run(() => writeFile(staging, source, {
      flag: "wx", mode: 0o600, flush: true, signal: deadline.signal,
    }))
    metadata = verify()
    deadline.check()
    const { byteLength, sha256 } = metadata
    // Download and staging spent the original budget. Publication gets at most
    // its own shorter budget and only the remainder of that same original one.
    publication = bootstrapDeadline(timeoutMs,
      `Bootstrap publication exceeded ${timeoutMs} ms; inspect ${path} before retrying because publication may have completed`, deadline)
    active = publication
    try {
      // A hard link publishes an already complete file without replacement.
      // Unique private staging plus immutable publication needs no shared lock.
      // Never fall back to rename/copy: either would restore the overwrite race.
      await publication.run(() => link(staging, path))
    } catch (error) {
      if (publication.signal.aborted) throw error
      if (error.code !== "EEXIST") {
        throw new Error(`Could not publish ${path} without replacement. ${error.message}`, { cause: error })
      }
    }
    await verifyPublishedArchive(path, byteLength, sha256, publication)
    verified = true
  } catch (error) { failure = error }

  try {
    if (directory) {
      // Only this invocation's private directory is eligible for cleanup.
      // No recursive deletion, legacy .partial cleanup, or final-archive unlink.
      await active.run(() => rm(join(directory, "archive.partial"), { force: true }))
      await active.run(() => rmdir(directory))
    }
  } catch (cleanup) {
    const outcome = verified ? `Archive verified at ${path}, but staging cleanup failed`
      : `Bootstrap did not finish; inspect ${path} before retrying`
    const message = `${outcome}. Retained staging may remain at ${directory}. ${failure?.message ?? cleanup.message}`
    failure = new AggregateError(failure ? [failure, cleanup] : [cleanup], message)
  } finally { publication?.clear() }
  if (failure) throw failure
  return metadata
}
