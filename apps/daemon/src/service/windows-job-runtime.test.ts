import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { readSupervisorStopRequest, writeSupervisorStopRequest, writeWindowsSupervisorRecord, windowsSupervisorRecordPath, type WindowsSupervisorRecord } from "./supervisor-record.js"
import { readWindowsSupervisorStatus, runWindowsSupervisor, stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { launchWindowsJob, queryWindowsProcess, queryWindowsProcesses } from "./windows-job.js"
import { claimExclusiveFileLease } from "../file-lease.js"

vi.mock("./windows-job.js", () => ({ queryWindowsProcess: vi.fn(), queryWindowsProcesses: vi.fn(), windowsProcessAlive: vi.fn(() => false), launchWindowsJob: vi.fn() }))
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); vi.resetAllMocks() })
function fixture(unknown = false) {
  const home = mkdtempSync(join(tmpdir(), "domovoi-windows-proof-")); homes.push(home)
  const directory = join(home, ".domovoi"), path = join(directory, "service.json")
  mkdirSync(directory, { mode: 0o700 })
  const config = { ...createServiceConfiguration({ DOMOVOI_PROFILE_DIR: directory }, { homeDirectory: home, workingDirectory: home, platform: process.platform }), registrationId: randomUUID() }
  const text = serializeServiceConfiguration(config)
  writeFileSync(path, text, { mode: 0o600 })
  const now = new Date().toISOString(), bootId = "windows-boot:42"
  const record: WindowsSupervisorRecord = { version: 1, platform: "win32", supervisorId: randomUUID(), registrationId: config.registrationId,
    configurationDigest: createHash("sha256").update(serializeServiceConfiguration(parseServiceConfiguration(text))).digest("hex"), loop: { pid: 123, start: "456", bootId },
    startedAt: now, updatedAt: now, state: unknown ? "failed" : "stopped", reason: unknown ? "observation-failure" : "deliberate-stop", crashes: 0,
    attempts: unknown ? [{ number: 1, job: `Local\\Domovoi-${randomUUID()}`, bootId, startedAt: now, stage: "intent", child: null, helper: null, empty: null, exitCode: null, backoffMs: 0 }] : [] }
  writeWindowsSupervisorRecord(home, record)
  vi.mocked(queryWindowsProcess).mockReturnValue({ bootId, identity: null })
  vi.mocked(queryWindowsProcesses).mockReturnValue({ bootId, identities: [null, null] })
  return { home, path, record }
}

it("uses the same boot-recovery explanation for status and stop and retains configuration", async () => {
  const f = fixture(true), deadline = OperationDeadline.start(2000)
  try {
    expect(readWindowsSupervisorStatus(f.home)).toMatchObject({ treeUnconfirmed: true, supervisionFailure: "observation-failure", detail: expect.stringContaining("Restart Windows") })
    await expect(stopWindowsSupervisor(f.path, deadline)).rejects.toThrow("Restart Windows")
    expect(existsSync(f.path)).toBe(true)
    expect(readSupervisorStopRequest(f.home)?.registrationId).toBe(f.record.registrationId)
  } finally { deadline.clear() }
})

it("observes boot, loop and daemon identities in one helper call for status", () => {
  const f = fixture(true), child = { ...f.record.loop, pid: 124 }
  const attempt = f.record.attempts[0]!
  attempt.stage = "running"; attempt.child = child; attempt.helper = { ...child, pid: 125 }
  f.record.state = "running"; f.record.reason = null
  writeWindowsSupervisorRecord(f.home, f.record)
  vi.mocked(queryWindowsProcesses).mockReturnValue({ bootId: f.record.loop.bootId, identities: [f.record.loop, child] })
  expect(readWindowsSupervisorStatus(f.home)).toMatchObject({ running: true })
  expect(queryWindowsProcesses).toHaveBeenCalledExactlyOnceWith([f.record.loop.pid, child.pid])
  expect(queryWindowsProcess).not.toHaveBeenCalled()
})

it("settles old attempts only after a successful different-boot observation", async () => {
  const f = fixture(true), deadline = OperationDeadline.start(2000)
  try {
    vi.mocked(queryWindowsProcess).mockImplementationOnce(() => { throw new Error("boot query denied") })
    await expect(stopWindowsSupervisor(f.path, deadline)).rejects.toThrow("boot query denied")
    expect(existsSync(f.path)).toBe(true)
    vi.mocked(queryWindowsProcess).mockReturnValue({ bootId: "windows-boot:43", identity: null })
    await expect(stopWindowsSupervisor(f.path, deadline)).resolves.toEqual(f.record)
  } finally { deadline.clear() }
})

it("clears retirement for update only after tree proof", async () => {
  const f = fixture(true), deadline = OperationDeadline.start(2000)
  try {
    await expect(stopWindowsSupervisor(f.path, deadline, { retire: false })).rejects.toThrow("Restart Windows")
    expect(readSupervisorStopRequest(f.home)).toBeDefined()
    vi.mocked(queryWindowsProcess).mockReturnValue({ bootId: "windows-boot:43", identity: null })
    await stopWindowsSupervisor(f.path, deadline, { retire: false })
    expect(readSupervisorStopRequest(f.home)).toBeUndefined()
  } finally { deadline.clear() }
})

it("refuses configuration drift before writing a stop request", async () => {
  const f = fixture(), deadline = OperationDeadline.start(2000)
  try {
    writeWindowsSupervisorRecord(f.home, { ...f.record, configurationDigest: "0".repeat(64) })
    await expect(stopWindowsSupervisor(f.path, deadline)).rejects.toThrow("does not match")
    expect(readSupervisorStopRequest(f.home)).toBeUndefined()
  } finally { deadline.clear() }
})

it("can prove the exact previous generation during rollback before a replacement started", async () => {
  const f = fixture(), deadline = OperationDeadline.start(2000)
  try {
    const previous = parseServiceConfiguration(readFileSync(f.path, "utf8"))
    writeFileSync(f.path, serializeServiceConfiguration({ ...previous, port: previous.port + 1 }))
    await expect(stopWindowsSupervisor(f.path, deadline)).rejects.toThrow("does not match")
    await expect(stopWindowsSupervisor(f.path, deadline, { retire: false, previousConfigurationDigest: f.record.configurationDigest })).resolves.toEqual(f.record)
    expect(readSupervisorStopRequest(f.home)).toBeUndefined()
  } finally { deadline.clear() }
})

it("retires a claimable lease with no launch record after a prelaunch failure", async () => {
  const f = fixture(), deadline = OperationDeadline.start(2000)
  rmSync(windowsSupervisorRecordPath(f.home))
  const lease = claimExclusiveFileLease(join(f.home, ".domovoi", "windows-supervisor-lease.sqlite"), () => new Error("busy"))
  lease.release()
  vi.mocked(queryWindowsProcess).mockReturnValue({ bootId: f.record.loop.bootId, identity: f.record.loop })
  try {
    expect(await stopWindowsSupervisor(f.path, deadline)).toMatchObject({ state: "stopped", attempts: [], reason: "deliberate-stop" })
    expect(readSupervisorStopRequest(f.home)?.registrationId).toBe(f.record.registrationId)
  } finally { deadline.clear() }
})

it("honors a retirement request racing the first record of a new loop", async () => {
  const f = fixture()
  const loop = { ...f.record.loop, pid: 321 }
  vi.mocked(queryWindowsProcess).mockReturnValue({ bootId: loop.bootId, identity: loop })
  vi.mocked(launchWindowsJob).mockImplementation(async (input) => {
    // Stop read the predecessor before this new loop published its identity.
    writeSupervisorStopRequest({ profileDirectory: join(f.home, ".domovoi") }, f.record)
    const receipt = { kind: "empty" as const, job: input.job, bootId: loop.bootId, activeProcesses: 0 as const, terminated: true as const, code: 1, stopped: true }
    return { prepared: { kind: "prepared", job: input.job, bootId: loop.bootId, child: { ...loop, pid: 322 }, helper: { ...loop, pid: 323 }, killOnClose: true, stdioOnly: true },
      resume: async () => {}, exited: new Promise(() => {}), stop: async () => receipt }
  })
  let emergencyStop = false
  const timer = setTimeout(() => { emergencyStop = true; process.emit("SIGTERM") }, 1000)
  try {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }))
    expect(await runWindowsSupervisor(f.path, { executable: "unused", args: [] })).toMatchObject({ state: "stopped", reason: "deliberate-stop" })
    expect(emergencyStop).toBe(false)
  } finally { clearTimeout(timer); vi.unstubAllGlobals() }
})
