import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { launchWindowsJob, parseWindowsJobMessage, windowsJobCommand, type WindowsJobTransport } from "./windows-job.js"
import { windowsJobSource } from "./windows-job-source.js"
import { assertWindowsTreeProof, superviseWindows } from "./windows-job-supervisor.js"
import { windowsSupervisorRecordSchema, type WindowsSupervisorRecord } from "./supervisor-record.js"

const bootId = "windows-boot:42"
beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
const job = `Global\\Domovoi-${randomUUID()}`
const identity = { pid: 123, start: "456", bootId }
const prepared = { kind: "prepared", job, bootId, child: identity, helper: { ...identity, pid: 124 }, killOnClose: true, stdioOnly: true }
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  let input = ""
  child.stdin.on("data", (chunk) => { input += String(chunk) })
  const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + "\n")
  return { child, send, input: () => input, transport: (() => child) as WindowsJobTransport }
}

it("does not interpolate launch data into the fixed helper program", () => {
  expect(windowsJobCommand()).toEqual(windowsJobCommand())
  expect(windowsJobCommand().command).toMatch(/WindowsPowerShell.*powershell\.exe$/i)
  expect(windowsJobCommand().args.join(" ").length).toBeLessThan(30_000)
})

it("does not change console encodings in the hidden helper", () => {
  expect(/(?:InputEncoding|OutputEncoding)\s*=/.test(windowsJobSource)).toBe(false)
})

it("shares one UTF-8 stdin reader between the request and command thread", () => {
  expect(windowsJobSource.match(/new StreamReader\(/g)).toHaveLength(1)
  expect(windowsJobSource).toContain("static readonly StreamReader Input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));")
  expect(windowsJobSource).toContain("public static string ReadRequest() { return Input.ReadLine(); }")
  expect(windowsJobSource).toContain("$request = [DomovoiJob]::ReadRequest() | ConvertFrom-Json")
  expect(windowsJobSource).toContain("while ((line = ReadRequest()) != null) commands.Add(line);")
  expect(/Console(?:\]|\.)?(?:::)?In\b/.test(windowsJobSource)).toBe(false)
})

it("emits parsed responses through a BOM-less UTF-8 stdout writer", () => {
  expect(windowsJobSource.match(/new StreamWriter\(/g)).toHaveLength(1)
  expect(windowsJobSource).toContain("static readonly StreamWriter Output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };")
  expect(windowsJobSource).toContain("static void Emit(object value) { Output.WriteLine(Json.Serialize(value)); }")
  expect(/Console(?:\]|\.)?(?:::)?Out\b/.test(windowsJobSource)).toBe(false)
})

it("holds the suspended child until the caller acknowledges durable evidence", async () => {
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: ["$(untrusted)'"], log: "C:\\out.log" }, f.transport)
  f.send(prepared)
  const launched = await pending
  expect(launched.prepared).toEqual(prepared)
  expect(f.input()).not.toContain('"resume"')
  const resumed = launched.resume()
  expect(f.input()).toContain('"resume"')
  f.send({ kind: "running", job })
  await resumed
  f.send({ kind: "empty", job, bootId, activeProcesses: 0, terminated: true, code: 9, stopped: false })
  f.child.emit("close", 0)
  expect(await launched.exited).toMatchObject({ code: 9, activeProcesses: 0, terminated: true })
})

it("collects late preparation and empty proof during startup timeout cleanup without resuming", async () => {
  vi.useFakeTimers()
  const f = fixture(), rejected = vi.fn()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  void pending.catch(rejected)
  try {
    await vi.advanceTimersByTimeAsync(25_000)
    expect(f.input()).toContain('"stop"')
    expect(rejected).not.toHaveBeenCalled()
    f.send(prepared)
    const receipt = { kind: "empty", job, bootId, activeProcesses: 0, terminated: true, code: 1, stopped: true }
    f.send(receipt)
    f.child.emit("close", 0)
    await expect(pending).rejects.toMatchObject({ prepared, receipt })
    expect(f.input()).not.toContain('"resume"')
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { f.child.emit("close", 1) }
})

it.each(["empty", "no-preparation", "no-proof", "deadline", "receipt-without-close", "failed-close", "invalid"] as const)("persists startup timeout evidence with %s cleanup", async (cleanup) => {
  vi.useFakeTimers()
  const f = fixture(), records: WindowsSupervisorRecord[] = []
  const pending = superviseWindows({ loop: identity, registrationId: randomUUID(), configurationDigest: "a".repeat(64), signal: new AbortController().signal }, {
    now: () => new Date(), write: (record) => { records.push(windowsSupervisorRecordSchema.parse(record)) },
    launch: (attempt) => launchWindowsJob({ job: attempt.job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport),
    wait: async () => { throw new Error("A timed-out launch must not restart") },
  })
  await vi.advanceTimersByTimeAsync(0)
  const request = JSON.parse(f.input().trim()) as { job: string }
  try {
    await vi.advanceTimersByTimeAsync(25_000)
    if (cleanup !== "no-preparation") f.send({ ...prepared, job: request.job })
    if (!["no-proof", "no-preparation", "deadline"].includes(cleanup)) {
      f.send({ kind: "empty", job: request.job, bootId, activeProcesses: 0, terminated: true, code: 1, stopped: true })
    }
    if (cleanup === "invalid") f.child.stdout.write("invalid\n")
    const stopExpired = cleanup === "deadline" || cleanup === "receipt-without-close"
    if (stopExpired) await vi.advanceTimersByTimeAsync(15_000)
    else f.child.emit("close", cleanup === "failed-close" ? 1 : 0)
    const record = await pending
    expect(record).toMatchObject({ state: "failed", reason: "observation-failure", crashes: 0 })
    expect(record.attempts).toHaveLength(1)
    if (cleanup === "no-preparation") expect(record.attempts[0]).toMatchObject({ child: null, helper: null, stage: "intent", empty: null })
    else expect(record.attempts[0]).toMatchObject({ child: prepared.child, helper: prepared.helper, killOnClose: true,
      stage: cleanup === "empty" ? "empty" : "prepared", empty: cleanup === "empty" ? { activeProcesses: 0, terminated: true } : null })
    expect(records.at(-1)).toEqual(record)
    if (cleanup === "empty") expect(() => assertWindowsTreeProof(record, bootId)).not.toThrow()
    else expect(() => assertWindowsTreeProof(record, bootId)).toThrow("Restart Windows")
    expect(f.input()).not.toContain('"resume"')
    expect(f.child.kill).toHaveBeenCalledTimes(stopExpired ? 1 : 0)
  } finally { f.child.emit("close", 1) }
})

it("does not accept daemon death or helper death as tree proof", async () => {
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  f.send(prepared)
  const launched = await pending
  f.child.emit("close", 0)
  await expect(launched.exited).rejects.toThrow("job-empty proof")
  await expect(launched.stop()).rejects.toThrow("job-empty proof")
})

it("refuses a different job, missing kill-on-close, and nonempty or unterminated proof", () => {
  expect(() => parseWindowsJobMessage({ ...prepared, job: `Global\\Domovoi-${randomUUID()}` }, job)).toThrow()
  expect(() => parseWindowsJobMessage({ ...prepared, killOnClose: false }, job)).toThrow()
  expect(() => parseWindowsJobMessage({ ...prepared, stdioOnly: false }, job)).toThrow()
  const empty = { kind: "empty", job, bootId, activeProcesses: 0, terminated: true, code: 0, stopped: true }
  expect(() => parseWindowsJobMessage({ ...empty, activeProcesses: 1 }, job)).toThrow()
  expect(() => parseWindowsJobMessage({ ...empty, terminated: false }, job)).toThrow()
})

it("requires the helper to confirm restricted handle inheritance before startup", () => {
  expect(() => parseWindowsJobMessage(prepared, job)).not.toThrow()
  const { stdioOnly: _omitted, ...unconfirmed } = prepared
  expect(() => parseWindowsJobMessage(unconfirmed, job)).toThrow()
})

it("rejects an empty receipt from another boot and requests helper shutdown", async () => {
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  f.send(prepared)
  const launched = await pending
  f.send({ kind: "empty", job, bootId: "windows-boot:43", activeProcesses: 0, terminated: true, code: 0, stopped: true })
  await expect(launched.exited).rejects.toThrow()
  expect(f.input()).toContain('"stop"')
  f.child.emit("close", 1)
})

it("does not accept a receipt followed by a failed helper exit", async () => {
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  f.send(prepared)
  const launched = await pending
  f.send({ kind: "empty", job, bootId, activeProcesses: 0, terminated: true, code: 0, stopped: true })
  f.child.emit("close", 1)
  await expect(launched.exited).rejects.toThrow("job-empty proof")
})

it("rejects a helper that resumes before acknowledgement", async () => {
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  f.send({ kind: "running", job })
  await expect(pending).rejects.toThrow("invalid")
  f.child.emit("close", 1)
})

it.each(["C:\\PowerShell 7\\Modules;C:\\User's Modules", undefined])("preserves the supervisor's PSModulePath value %s outside script source", async (value) => {
  vi.stubEnv("PSModulePath", value)
  const f = fixture()
  const pending = launchWindowsJob({ job, executable: "C:\\node.exe", args: [], log: "C:\\out.log" }, f.transport)
  f.send(prepared)
  const launched = await pending
  // Shut down even when the assertion fails; this test owns the fake helper.
  const request = JSON.parse(f.input().trim()) as { psModulePath?: string | null }
  f.send({ kind: "empty", job, bootId, activeProcesses: 0, terminated: true, code: 0, stopped: true })
  f.child.emit("close", 0)
  await launched.exited
  expect(request.psModulePath).toBe(value ?? null)
})
