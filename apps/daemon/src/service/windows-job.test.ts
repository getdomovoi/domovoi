import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { launchWindowsJob, parseWindowsJobMessage, windowsJobCommand, type WindowsJobTransport } from "./windows-job.js"

const bootId = "windows-boot:42"
beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => vi.unstubAllEnvs())
const job = `Local\\Domovoi-${randomUUID()}`
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
  expect(() => parseWindowsJobMessage({ ...prepared, job: `Local\\Domovoi-${randomUUID()}` }, job)).toThrow()
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
