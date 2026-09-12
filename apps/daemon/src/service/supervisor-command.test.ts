import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { afterEach, expect, it } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { nodeServiceEffects, runServiceCommand } from "./install.js"
import { readGuestSupervisorStatus, runGuestSupervisor, stopGuestSupervisor, supervisorConfigurationDigest } from "./supervisor-command.js"
import { guestProcessAlive, guestProcessIdentity } from "./supervisor-process.js"
import { readSupervisorRecord, readSupervisorStopRequest, supervisorStopPath, writeSupervisorStopRequest, writeSupervisorRecord, type SupervisorRecord } from "./supervisor-record.js"

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "domovoi-supervisor-status-"))
  homes.push(home)
  mkdirSync(join(home, ".domovoi"), { mode: 0o700 })
  const configuration = { ...createServiceConfiguration({}, { homeDirectory: home, workingDirectory: home, platform: process.platform }), registrationId: randomUUID() }
  const path = join(home, ".domovoi/service.json")
  writeFileSync(path, serializeServiceConfiguration(configuration), { mode: 0o600 })
  const loop = { pid: 100, start: "1000", bootId: randomUUID() }
  const record: SupervisorRecord = {
    version: 1, supervisorId: randomUUID(), registrationId: configuration.registrationId!,
    configurationDigest: supervisorConfigurationDigest(configuration), loop,
    startedAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-12T12:00:01.000Z",
    state: "backoff", attemptCount: 1, crashes: 1, reason: null,
    attempts: [{ number: 1, child: { ...loop, pid: 101, start: "1001" }, startedAt: "2026-09-12T12:00:00.000Z",
      exit: { kind: "crash", code: 127, signal: null, errorCode: null, at: "2026-09-12T12:00:01.000Z" }, backoffMs: 1000,
      backoffEndedAt: null, backoffOutcome: null }],
  }
  return { home, path, record }
}

it("reports exhaustion count, last exit and time from the record", () => {
  const f = fixture()
  f.record.state = "exhausted"
  f.record.attemptCount = 4; f.record.crashes = 4
  f.record.reason = { kind: "restart-limit", at: "2026-09-12T12:01:00.000Z" }
  f.record.attempts = [1000, 5000, 15000, 0].map((backoffMs, index) => ({
    ...f.record.attempts[0]!, number: index + 1, backoffMs: backoffMs as 0 | 1000 | 5000 | 15000,
    backoffEndedAt: backoffMs ? "2026-09-12T12:00:30.000Z" : null,
    backoffOutcome: backoffMs ? "completed" : null,
  }))
  writeSupervisorRecord(f.home, f.record)
  const status = readGuestSupervisorStatus(f.home, () => false)
  expect(status).toMatchObject({ installed: null, running: false })
  expect(status?.detail).toContain("supervision exhausted after 4 crashes")
  expect(status?.detail).toContain("last exit code 127 at 2026-09-12T12:00:01.000Z")
})

it("does not turn a stale loop record into running supervision", () => {
  const f = fixture()
  f.record.state = "running"; f.record.crashes = 0
  f.record.attempts[0]!.exit = null; f.record.attempts[0]!.backoffMs = 0
  writeSupervisorRecord(f.home, f.record)
  expect(readGuestSupervisorStatus(f.home, () => false)).toMatchObject({ running: false, detail: expect.stringContaining("supervisor is not alive") })
})

it("refuses evidence bound to another registration", () => {
  const f = fixture()
  f.record.registrationId = randomUUID()
  writeSupervisorRecord(f.home, f.record)
  expect(() => readGuestSupervisorStatus(f.home, () => true)).toThrow("does not match the installed service configuration")
})

it("leaves an ordinary profile without supervisor artefacts to its native service manager", () => {
  const f = fixture()
  chmodSync(join(f.home, ".domovoi"), 0o755)
  expect(readGuestSupervisorStatus(f.home, () => false)).toBeUndefined()
})

it("refuses a missing record after a supervisor lease was created", () => {
  const f = fixture()
  writeFileSync(join(f.home, ".domovoi/supervisor-lease.sqlite"), "", { mode: 0o600 })
  expect(() => readGuestSupervisorStatus(f.home, () => false)).toThrow("Supervisor record is missing")
})

it("refuses removal when the loop is dead but its exact guest child is alive", async () => {
  const f = fixture()
  writeSupervisorRecord(f.home, f.record)
  const deadline = OperationDeadline.start(1000)
  try {
    await expect(stopGuestSupervisor(f.path, deadline, {
      alive: (identity) => identity.pid === f.record.attempts[0]!.child!.pid,
      wait: async () => { throw new Error("must refuse before waiting") },
    })).rejects.toThrow("guest child is still alive; removal refused")
  } finally { deadline.clear() }
})

it("propagates an unreadable process identity instead of declaring shutdown", async () => {
  const f = fixture()
  writeSupervisorRecord(f.home, f.record)
  const failure = new Error("proc unreadable")
  const deadline = OperationDeadline.start(1000)
  try {
    await expect(stopGuestSupervisor(f.path, deadline, {
      alive: () => { throw failure },
      wait: async () => {},
    })).rejects.toBe(failure)
  } finally { deadline.clear() }
})

it("refuses removal of a dead loop whose launch outcome was never recorded", async () => {
  const f = fixture()
  f.record.state = "starting"; f.record.crashes = 0
  Object.assign(f.record.attempts[0]!, { child: null, exit: null, backoffMs: 0 })
  writeSupervisorRecord(f.home, f.record)
  expect(() => readGuestSupervisorStatus(f.home, () => false)).toThrow("launch has no recorded child outcome")
  const deadline = OperationDeadline.start(1000)
  try {
    await expect(stopGuestSupervisor(f.path, deadline, { alive: () => false, wait: async () => {} }))
      .rejects.toThrow("launch has no recorded child outcome")
  } finally { deadline.clear() }
})

it("targets one loop, cancels backoff, then proves loop and child dead", async () => {
  const f = fixture()
  writeSupervisorRecord(f.home, f.record)
  let alive = true
  const deadline = OperationDeadline.start(1000)
  try {
    const stopped = await stopGuestSupervisor(f.path, deadline, {
      alive: (process) => alive && process.pid === f.record.loop.pid,
      wait: async () => {
        expect(readSupervisorStopRequest(f.home)).toMatchObject({ supervisorId: f.record.supervisorId, loop: f.record.loop })
        alive = false
        f.record.attempts[0]!.backoffOutcome = "cancelled"
        f.record.attempts[0]!.backoffEndedAt = "2026-09-12T12:00:02.000Z"
        writeSupervisorRecord(f.home, { ...f.record, state: "stopped", reason: { kind: "deliberate-stop", at: "2026-09-12T12:00:02.000Z" } })
      },
    })
    expect(stopped.state).toBe("stopped")
    expect(stopped.crashes).toBe(1)
  } finally { deadline.clear() }
})

it("refuses a successor loop instead of accepting its stopped predecessor", async () => {
  const f = fixture()
  writeSupervisorRecord(f.home, f.record)
  const deadline = OperationDeadline.start(1000)
  try {
    await expect(stopGuestSupervisor(f.path, deadline, {
      alive: () => true,
      wait: async () => { writeSupervisorRecord(f.home, { ...f.record, supervisorId: randomUUID() }) },
    })).rejects.toThrow("Supervisor identity changed during shutdown")
  } finally { deadline.clear() }
})

it("service status reports guest evidence without probing an unrelated systemd unit", async () => {
  const f = fixture()
  writeSupervisorRecord(f.home, { ...f.record, state: "stopped", reason: { kind: "deliberate-stop", at: f.record.updatedAt } })
  const output: string[] = []
  const errors: string[] = []
  const status = await runServiceCommand(["service", "status"], {
    ...nodeServiceEffects({ userHomeDirectory: f.home }),
    supervisorStatus: async (home: string) => readGuestSupervisorStatus(home, () => false),
    capture: async () => { throw new Error("unrelated systemd query") },
    platform: "linux", execPath: "/daemon.js", home: f.home,
    stdout: (text) => output.push(text), stderr: (text) => errors.push(text),
  })
  expect(errors).toEqual([])
  expect(status).toBe(0)
  expect(output.join("")).toContain("Windows task registration unverified: stopped (deliberate-stop)")
  expect(output.join("")).toContain("last exit code 127 at 2026-09-12T12:00:01.000Z")
})

it.runIf(process.platform === "linux")("runs a real child and records its clean exit without a restart", async () => {
  const f = fixture()
  const record = await runGuestSupervisor(f.path, { executable: process.execPath, args: ["-e", "process.exitCode = 0"] })
  expect(record).toMatchObject({ state: "stopped", attemptCount: 1, crashes: 0, reason: { kind: "clean-exit" } })
  expect(record.attempts[0]!.exit).toMatchObject({ kind: "clean", code: 0 })
  expect(guestProcessAlive(record.attempts[0]!.child!)).toBe(false)
})

it.runIf(process.platform === "linux")("refuses a retired registration before another child can launch", async () => {
  const f = fixture()
  writeSupervisorStopRequest(f.home, f.record)
  await expect(runGuestSupervisor(f.path, { executable: process.execPath, args: ["-e", "process.exit(0)"] }))
    .rejects.toThrow("registration was stopped for removal")
  expect(readSupervisorRecord(f.home)).toBeUndefined()
})

it.runIf(process.platform === "linux")("refuses a recorded live child even when its loop is dead", async () => {
  const f = fixture()
  f.record.attempts[0]!.child = guestProcessIdentity(process.pid)
  writeSupervisorRecord(f.home, f.record)
  await expect(runGuestSupervisor(f.path, { executable: process.execPath, args: ["-e", "process.exit(0)"] }))
    .rejects.toThrow("guest child is still alive")
  expect(readSupervisorRecord(f.home)?.supervisorId).toBe(f.record.supervisorId)
})

it.runIf(process.platform === "linux")("refuses another loop after an unobservable launch", async () => {
  const f = fixture()
  f.record.state = "starting"; f.record.crashes = 0
  Object.assign(f.record.attempts[0]!, { child: null, exit: null, backoffMs: 0 })
  writeSupervisorRecord(f.home, f.record)
  await expect(runGuestSupervisor(f.path, { executable: process.execPath, args: ["-e", "process.exit(0)"] }))
    .rejects.toThrow("launch has no recorded child outcome")
})

it.runIf(process.platform === "linux")("a corrupt stop request stops the real child and refuses further supervision", async () => {
  const f = fixture()
  const running = runGuestSupervisor(f.path, { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] })
  // Attach rejection before the monitor can report the injected failure.
  const completed = running.then((record) => ({ record }), (error: unknown) => ({ error }))
  const deadline = OperationDeadline.start(5_000)
  try {
    while (readSupervisorRecord(f.home)?.state !== "running") {
      deadline.throwIfExpired()
      await delay(10)
    }
    writeFileSync(supervisorStopPath(f.home), "{broken", { mode: 0o600 })
    const result = await completed
    expect(result).toMatchObject({ error: expect.objectContaining({ message: "Supervisor stop request is invalid or inaccessible" }) })
    const record = readSupervisorRecord(f.home)!
    expect(record).toMatchObject({ state: "failed", attemptCount: 1, crashes: 0, reason: { kind: "observation-failure" } })
    expect(guestProcessAlive(record.attempts[0]!.child!)).toBe(false)
  } finally {
    deadline.clear()
    const record = readSupervisorRecord(f.home)
    if (record) writeSupervisorStopRequest(f.home, record)
    await completed
  }
})
