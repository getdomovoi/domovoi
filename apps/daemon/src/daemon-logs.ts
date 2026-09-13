import {
  chmodSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeSync, type Stats,
} from "node:fs"
import { join } from "node:path"

import { redactErrorDetail } from "./rpc-errors.js"
import type { DaemonErrorEntry } from "./server.js"

const maximumFileBytes = 1_024 * 1_024
const maximumFiles = 5
const maximumRecordBytes = 16 * 1_024

type LogLimits = { maximumFileBytes?: number; maximumFiles?: number }

/** One writer under the production profile lease. No open handle survives a write. */
export class RotatingDaemonLog {
  readonly #directory: string
  readonly #maximumFileBytes: number
  readonly #maximumFiles: number
  #closed = false

  constructor(directory: string, limits: LogLimits = {}) {
    this.#directory = directory
    this.#maximumFileBytes = limits.maximumFileBytes ?? maximumFileBytes
    this.#maximumFiles = limits.maximumFiles ?? maximumFiles
    if (!Number.isSafeInteger(this.#maximumFileBytes) || this.#maximumFileBytes < 256 || this.#maximumFileBytes > maximumFileBytes
      || !Number.isSafeInteger(this.#maximumFiles) || this.#maximumFiles < 1 || this.#maximumFiles > maximumFiles) {
      throw new Error("Daemon log limits must fit the shipped byte and file budgets")
    }
  }

  append(entry: DaemonErrorEntry): void {
    if (this.#closed) return
    const content = encodeRecord(entry, Math.min(this.#maximumFileBytes, maximumRecordBytes))
    this.#prepareDirectory()
    // Read the actual files, including archives, on every write. A restart or
    // interrupted rotation must never reset a cached size or retention count.
    const present = Array.from({ length: this.#maximumFiles }, (_, index) => this.#inspect(this.#path(index)) !== undefined)
    let descriptor: number | undefined
    try {
      descriptor = this.#openActive()
      let size = this.#repairTail(descriptor)
      if (size + content.length > this.#maximumFileBytes) {
        closeSync(descriptor)
        descriptor = undefined
        // On any failure, do not append. Individual renames can lose an old
        // archive during a crash, but cannot create an over-budget file.
        if (present[this.#maximumFiles - 1]) unlinkSync(this.#path(this.#maximumFiles - 1))
        for (let index = this.#maximumFiles - 2; index >= 0; index -= 1) {
          if (present[index]) renameSync(this.#path(index), this.#path(index + 1))
        }
        descriptor = this.#openActive()
        size = 0
      }
      try {
        let offset = 0
        while (offset < content.length) {
          const written = writeSync(descriptor, content, offset, content.length - offset, size + offset)
          if (written === 0) throw new Error("Daemon log write made no progress")
          offset += written
        }
      } catch (error) {
        let cleanupFailure: { error: unknown } | undefined
        try { ftruncateSync(descriptor, size) } catch (cleanupError) { cleanupFailure = { error: cleanupError } }
        if (cleanupFailure) {
          throw new AggregateError([error, cleanupFailure.error], "Daemon log append and partial-record cleanup failed", { cause: error })
        }
        throw error
      }
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }

  /** Late callbacks from a stopped owner must not write into the next owner's log. */
  close(): void { this.#closed = true }

  #path(index: number): string {
    return join(this.#directory, index === 0 ? "daemon.jsonl" : `daemon.${index}.jsonl`)
  }

  #prepareDirectory(): void {
    try { mkdirSync(this.#directory, { mode: 0o700 }) } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error
    }
    const info = lstatSync(this.#directory)
    if (!info.isDirectory() || (process.platform !== "win32" && info.uid !== process.getuid?.())) {
      throw new Error("Daemon log directory must be owned and must not be a symbolic link")
    }
    if (process.platform !== "win32") chmodSync(this.#directory, 0o700)
  }

  #inspect(path: string): Stats | undefined {
    let info: Stats
    try { info = lstatSync(path) } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
    this.#assertFile(info)
    return info
  }

  #assertFile(info: Stats): void {
    if (!info.isFile()) throw new Error("Daemon logs require a regular file")
    if (info.nlink !== 1) throw new Error("Daemon log file must have exactly one hard link")
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error("Daemon logs require a private file owned by the current user")
    }
    if (info.size > this.#maximumFileBytes) throw new Error("Existing daemon log exceeds its size limit")
  }

  #openActive(): number {
    const descriptor = openSync(this.#path(0), constants.O_RDWR | constants.O_CREAT
      | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
    try {
      this.#assertFile(fstatSync(descriptor))
      return descriptor
    } catch (error) {
      closeSync(descriptor)
      throw error
    }
  }

  #repairTail(descriptor: number): number {
    const size = fstatSync(descriptor).size
    if (size === 0) return 0
    const last = Buffer.alloc(1)
    if (readSync(descriptor, last, 0, 1, size - 1) !== 1) throw new Error("Daemon log changed during tail inspection")
    if (last[0] === 0x0a) return size
    // A killed writer can leave a partial JSON record. Keep all complete lines;
    // inspect at most one bounded file rather than reading arbitrary history.
    const content = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, content, offset, size - offset, offset)
      if (count === 0) throw new Error("Daemon log changed during tail repair")
      offset += count
    }
    const complete = content.lastIndexOf(0x0a) + 1
    ftruncateSync(descriptor, complete)
    return complete
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function prefix(value: string, length: number): string {
  const end = value.charCodeAt(length - 1)
  return value.slice(0, end >= 0xd800 && end <= 0xdbff ? length - 1 : length)
}

function encodeRecord(entry: DaemonErrorEntry, maximumBytes: number): Buffer {
  const record: { occurredAt: string; context: string; detail: string; truncated?: true } = {
    occurredAt: new Date().toISOString(),
    context: redactErrorDetail(entry.context),
    detail: redactErrorDetail(entry.detail),
  }
  const encode = () => Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
  let encoded = encode()
  if (encoded.length <= maximumBytes) return encoded
  record.truncated = true
  const detail = record.detail
  record.detail = ""
  // Redact first, then fit actual serialized bytes. UTF-16 length misses both
  // multibyte text and JSON escaping. Never split a surrogate pair.
  const fit = (key: "context" | "detail", value: string) => {
    let low = 0
    let high = value.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      record[key] = prefix(value, middle)
      if (encode().length <= maximumBytes) low = middle
      else high = middle - 1
    }
    record[key] = prefix(value, low)
  }
  fit("context", record.context)
  fit("detail", detail)
  encoded = encode()
  return encoded
}
