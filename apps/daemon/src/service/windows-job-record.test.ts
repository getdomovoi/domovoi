import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { readWindowsSupervisorRecord, writeWindowsSupervisorRecord, windowsSupervisorRecordSchema, type WindowsSupervisorRecord } from "./supervisor-record.js"

export function windowsRecordFixture(): WindowsSupervisorRecord {
  return {
    version: 1, platform: "win32", supervisorId: randomUUID(), registrationId: randomUUID(), configurationDigest: "a".repeat(64),
    loop: { pid: 123, start: "456", bootId: "windows-boot:42" }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    state: "starting", attempts: [], crashes: 0, reason: null,
  }
}

it("round trips private Windows evidence separately from WSL evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "domovoi-windows-record-"))
  try {
    const record = windowsRecordFixture()
    writeWindowsSupervisorRecord(home, record)
    expect(readWindowsSupervisorRecord(home)).toEqual(record)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it("rejects successful termination without an empty-job observation", () => {
  const record = windowsRecordFixture()
  expect(windowsSupervisorRecordSchema.safeParse({ ...record, state: "stopped", reason: "deliberate-stop", attempts: [{
    number: 1, job: `Global\\Domovoi-${randomUUID()}`, bootId: record.loop.bootId, startedAt: record.startedAt,
    child: null, helper: null, stage: "intent", empty: null, exitCode: null, backoffMs: 0,
  }] }).success).toBe(false)
})

it("allows failed observations to retain unfinished attempts", () => {
  const record = windowsRecordFixture()
  expect(windowsSupervisorRecordSchema.safeParse({ ...record, state: "failed", reason: "observation-failure", attempts: [{
    number: 1, job: `Global\\Domovoi-${randomUUID()}`, bootId: record.loop.bootId, startedAt: record.startedAt,
    child: null, helper: null, stage: "intent", empty: null, exitCode: null, backoffMs: 0,
  }] }).success).toBe(true)
})

it("rejects loader GUIDs and invalid Windows boot counters", () => {
  const record = windowsRecordFixture()
  for (const bootId of [randomUUID(), "windows-boot:-1", "windows-boot:4294967296", "windows-boot:01", "windows-boot:NaN"]) {
    expect(windowsSupervisorRecordSchema.safeParse({ ...record, loop: { ...record.loop, bootId } }).success).toBe(false)
  }
})

it("requires Global job names so sign-in cannot hide an old session's job", () => {
  const record = windowsRecordFixture()
  const attempt = { number: 1, job: `Global\\Domovoi-${randomUUID()}`, bootId: record.loop.bootId,
    startedAt: record.startedAt, stage: "intent", child: null, helper: null, empty: null, exitCode: null, backoffMs: 0 }
  expect(windowsSupervisorRecordSchema.safeParse({ ...record, attempts: [attempt] }).success).toBe(true)
  expect(windowsSupervisorRecordSchema.safeParse({ ...record, attempts: [{ ...attempt, job: attempt.job.replace("Global", "Local") }] }).success).toBe(false)
})
