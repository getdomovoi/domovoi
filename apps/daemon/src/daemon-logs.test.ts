import { ftruncateSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { RotatingDaemonLog } from "./daemon-logs.js"
import { removeScratchDirectories } from "./test-scratch.js"

vi.mock("node:fs", { spy: true })

const roots: string[] = []
afterEach(async () => removeScratchDirectories(roots))

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "domovoi-log-retention-"))
  roots.push(root)
  return join(root, "logs")
}

function records(path: string) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
}

describe("RotatingDaemonLog", () => {
  it("rotates before overflow and keeps the newest files across restart", async () => {
    const path = await directory()
    let log = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 3 })
    for (let index = 0; index < 4; index += 1) log.append({ context: `event-${index}`, detail: "x".repeat(100) })
    log.close()
    log = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 3 })
    log.append({ context: "event-4", detail: "x".repeat(100) })
    log.close()
    expect(readdirSync(path).sort()).toEqual(["daemon.1.jsonl", "daemon.2.jsonl", "daemon.jsonl"])
    expect(["daemon.2.jsonl", "daemon.1.jsonl", "daemon.jsonl"].flatMap((name) => records(join(path, name)).map((record) => record.context)))
      .toEqual(["event-2", "event-3", "event-4"])
    for (const name of readdirSync(path)) expect(statSync(join(path, name)).size).toBeLessThanOrEqual(256)
  })

  it("enforces the shipped five-file, one-MiB budgets without test overrides", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path)
    for (let index = 0; index < 1_600; index += 1) log.append({ context: `event-${index}`, detail: "x".repeat(4_096) })
    log.close()
    const names = readdirSync(path).sort()
    expect(names).toEqual(["daemon.1.jsonl", "daemon.2.jsonl", "daemon.3.jsonl", "daemon.4.jsonl", "daemon.jsonl"])
    for (const name of names) expect(statSync(join(path, name)).size).toBeLessThanOrEqual(1_024 * 1_024)
    const retained = ["daemon.4.jsonl", "daemon.3.jsonl", "daemon.2.jsonl", "daemon.1.jsonl", "daemon.jsonl"]
      .flatMap((name) => records(join(path, name)).map((record) => record.context))
    expect(retained[0]).not.toBe("event-0")
    expect(retained.at(-1)).toBe("event-1599")
    const start = Number(retained[0].slice("event-".length))
    expect(retained).toEqual(Array.from({ length: 1_600 - start }, (_, index) => `event-${index + start}`))
  })

  it("redacts before storage and bounds encoded UTF-8 and JSON escaping", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 3 })
    log.append({ context: "token=context-secret", detail: "Authorization: Bearer detail-secret" })
    log.append({ context: "multibyte", detail: "你🙂\u0000\"".repeat(2_000) })
    log.close()
    const stored = readdirSync(path).map((name) => readFileSync(join(path, name), "utf8"))
    expect(stored.join("")).not.toContain("context-secret")
    expect(stored.join("")).not.toContain("detail-secret")
    expect(stored.join("")).toContain("[REDACTED]")
    const entries = stored.flatMap((text) => text.trim().split("\n").map((line) => JSON.parse(line)))
    expect(entries.find((record) => record.context === "multibyte")).toMatchObject({ truncated: true })
    for (const text of stored) {
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(256)
      expect(text).not.toContain("\ufffd")
    }
  })

  it("discards only an incomplete tail after restart", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path)
    log.append({ context: "complete", detail: "kept" })
    log.close()
    const active = join(path, "daemon.jsonl")
    const complete = readFileSync(active, "utf8")
    writeFileSync(active, `${complete}{"occurredAt":"partial`)
    const reopened = new RotatingDaemonLog(path)
    reopened.append({ context: "next", detail: "kept too" })
    reopened.close()
    expect(records(active).map((record) => record.context)).toEqual(["complete", "next"])
    expect(readFileSync(active, "utf8").startsWith(complete)).toBe(true)
  })

  it("refuses a blocked archive without growing the active file", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 2 })
    log.append({ context: "first", detail: "x".repeat(100) })
    const active = readFileSync(join(path, "daemon.jsonl"))
    mkdirSync(join(path, "daemon.1.jsonl"))
    expect(() => log.append({ context: "second", detail: "x".repeat(100) })).toThrow("regular file")
    expect(readFileSync(join(path, "daemon.jsonl"))).toEqual(active)
    log.close()
  })

  it("recovers the file set after a rename fails halfway through rotation", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 3 })
    for (let index = 0; index < 3; index += 1) log.append({ context: `event-${index}`, detail: "x".repeat(100) })
    const active = readFileSync(join(path, "daemon.jsonl"))
    const io = await vi.importActual<typeof import("node:fs")>("node:fs")
    const failure = Object.assign(new Error("rotation denied"), { code: "EACCES" })
    vi.mocked(renameSync).mockImplementationOnce(io.renameSync).mockImplementationOnce(() => { throw failure })
    try {
      expect(() => log.append({ context: "failed", detail: "x".repeat(100) })).toThrow(failure)
      expect(readFileSync(join(path, "daemon.jsonl"))).toEqual(active)
    } finally { vi.mocked(renameSync).mockImplementation(io.renameSync) }
    log.close()
    const reopened = new RotatingDaemonLog(path, { maximumFileBytes: 256, maximumFiles: 3 })
    reopened.append({ context: "recovered", detail: "x".repeat(100) })
    reopened.close()
    expect(records(join(path, "daemon.jsonl"))[0]).toMatchObject({ context: "recovered" })
    expect(records(join(path, "daemon.1.jsonl"))[0]).toMatchObject({ context: "event-2" })
    for (const name of readdirSync(path)) expect(statSync(join(path, name)).size).toBeLessThanOrEqual(256)
  })

  it.each([false, true])("preserves a failed write and repairs its partial tail, cleanup failure: %s", async (failCleanup) => {
    const path = await directory()
    const log = new RotatingDaemonLog(path)
    log.append({ context: "complete", detail: "kept" })
    const active = join(path, "daemon.jsonl")
    const before = readFileSync(active)
    const io = await vi.importActual<typeof import("node:fs")>("node:fs")
    const writeFailure = Object.assign(new Error("disk full"), { code: "ENOSPC" })
    const cleanupFailure = Object.assign(new Error("truncate denied"), { code: "EACCES" })
    vi.mocked(writeSync).mockImplementationOnce((descriptor) => {
      io.writeSync(descriptor, '{"partial"', before.length, "utf8")
      throw writeFailure
    })
    if (failCleanup) vi.mocked(ftruncateSync).mockImplementationOnce(() => { throw cleanupFailure })
    try {
      let caught: unknown
      try { log.append({ context: "failed", detail: "not retained" }) } catch (error) { caught = error }
      if (failCleanup) {
        expect(caught).toBeInstanceOf(AggregateError)
        expect(caught).toMatchObject({ cause: writeFailure, errors: [writeFailure, cleanupFailure] })
      } else {
        expect(caught).toBe(writeFailure)
        expect(readFileSync(active)).toEqual(before)
      }
    } finally {
      vi.mocked(writeSync).mockImplementation(io.writeSync)
      vi.mocked(ftruncateSync).mockImplementation(io.ftruncateSync)
      log.close()
    }
    const reopened = new RotatingDaemonLog(path)
    reopened.append({ context: "recovered", detail: "kept too" })
    reopened.close()
    expect(records(active).map((record) => record.context)).toEqual(["complete", "recovered"])
  })

  it("refuses linked files and leaves the external content untouched", async () => {
    const path = await directory()
    mkdirSync(path)
    const external = join(path, "..", "external")
    writeFileSync(external, "outside")
    linkSync(external, join(path, "daemon.jsonl"))
    const log = new RotatingDaemonLog(path)
    expect(() => log.append({ context: "probe", detail: "no write" })).toThrow("exactly one hard link")
    expect(readFileSync(external, "utf8")).toBe("outside")
    log.close()
  })

  it("refuses a linked log directory", async () => {
    const path = await directory()
    const external = join(path, "..", "external")
    mkdirSync(external)
    symlinkSync(external, path, process.platform === "win32" ? "junction" : "dir")
    const log = new RotatingDaemonLog(path)
    expect(() => log.append({ context: "probe", detail: "no write" })).toThrow("directory")
    expect(readdirSync(external)).toEqual([])
    log.close()
    // Do not ask recursive scratch cleanup to traverse a Windows junction.
    unlinkSync(path)
  })

  it("refuses oversized existing files instead of archiving them above the cap", async () => {
    const path = await directory()
    mkdirSync(path)
    const active = join(path, "daemon.jsonl")
    writeFileSync(active, "x".repeat(257), { mode: 0o600 })
    const log = new RotatingDaemonLog(path, { maximumFileBytes: 256 })
    expect(() => log.append({ context: "probe", detail: "no write" })).toThrow("size limit")
    expect(statSync(active).size).toBe(257)
    log.close()
  })

  it("stops writing after close and creates private files", async () => {
    const path = await directory()
    const log = new RotatingDaemonLog(path)
    log.append({ context: "before-close", detail: "kept" })
    log.close()
    log.append({ context: "after-close", detail: "not kept" })
    expect(records(join(path, "daemon.jsonl")).map((record) => record.context)).toEqual(["before-close"])
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o700)
      expect(statSync(join(path, "daemon.jsonl")).mode & 0o777).toBe(0o600)
    }
  })
})
