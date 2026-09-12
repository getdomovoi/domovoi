import { randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { readSupervisorRecord, supervisorRecordPath, supervisorRecordSchema, writeSupervisorRecord, type SupervisorRecord } from "./supervisor-record.js"

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const home = () => { const path = mkdtempSync(join(tmpdir(), "domovoi-supervisor-")); homes.push(path); return path }
const recordFixture = (): SupervisorRecord => ({
  version: 1, supervisorId: randomUUID(), registrationId: randomUUID(), configurationDigest: "a".repeat(64),
  loop: { pid: 123, start: "456", bootId: randomUUID() }, startedAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z", state: "starting", attemptCount: 0, crashes: 0, attempts: [], reason: null,
})

it("publishes one private complete record and leaves no staging file", () => {
  const root = home()
  const first = recordFixture()
  expect(readSupervisorRecord(root)).toBeUndefined()
  writeSupervisorRecord(root, first)
  expect(readSupervisorRecord(root)).toEqual(first)
  expect(JSON.parse(readFileSync(supervisorRecordPath(root), "utf8"))).toEqual(first)
  expect(readdirSync(join(root, ".domovoi"))).toEqual(["supervisor.json"])
  const next = { ...first, updatedAt: "2026-09-12T12:00:01.000Z" }
  writeSupervisorRecord(root, next)
  expect(readSupervisorRecord(root)).toEqual(next)
})

it("rejects counter drift, excessive history and a running state without a child", () => {
  expect(supervisorRecordSchema.safeParse({ ...recordFixture(), attemptCount: 1 }).success).toBe(false)
  expect(supervisorRecordSchema.safeParse({ ...recordFixture(), crashes: 4 }).success).toBe(false)
  expect(supervisorRecordSchema.safeParse({ ...recordFixture(), state: "running" }).success).toBe(false)
  expect(supervisorRecordSchema.safeParse({ ...recordFixture(), attempts: Array(5).fill({}) }).success).toBe(false)
})

it("rejects a clean-stop claim with no clean child exit", () => {
  const record = recordFixture()
  expect(supervisorRecordSchema.safeParse({ ...record, state: "stopped",
    reason: { kind: "clean-exit", at: record.updatedAt } }).success).toBe(false)
})

it("requires a birth identity for every launched child exit", () => {
  const record = recordFixture()
  expect(supervisorRecordSchema.safeParse({ ...record, state: "stopped", attemptCount: 1,
    reason: { kind: "clean-exit", at: record.updatedAt },
    attempts: [{ number: 1, startedAt: record.startedAt, child: null, backoffMs: 0,
      backoffEndedAt: null, backoffOutcome: null,
      exit: { kind: "clean", code: 0, signal: null, errorCode: null, at: record.updatedAt } }],
  }).success).toBe(false)
})

it("refuses oversized and corrupt input without echoing its content", () => {
  const root = home()
  writeSupervisorRecord(root, recordFixture())
  writeFileSync(supervisorRecordPath(root), "secret-marker".repeat(2000))
  expect(() => readSupervisorRecord(root)).toThrow("Supervisor record is invalid or inaccessible")
  try { readSupervisorRecord(root) } catch (error) { expect(String(error)).not.toContain("secret-marker") }
})

it.runIf(process.platform !== "win32")("refuses symlinks and public record files", () => {
  const root = home()
  writeSupervisorRecord(root, recordFixture())
  const path = supervisorRecordPath(root)
  chmodSync(path, 0o644)
  expect(() => readSupervisorRecord(root)).toThrow("Supervisor record is invalid or inaccessible")
  chmodSync(path, 0o600)
  const outside = join(root, "outside")
  writeFileSync(outside, "untouched")
  rmSync(path)
  symlinkSync(outside, path)
  expect(() => readSupervisorRecord(root)).toThrow("Supervisor record is invalid or inaccessible")
  expect(() => writeSupervisorRecord(root, recordFixture())).toThrow()
  expect(readFileSync(outside, "utf8")).toBe("untouched")
})
