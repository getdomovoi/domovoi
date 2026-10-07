import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"

import { assertWindowsStartup, assertWindowsTreeProof, superviseWindows, windowsSupervisorStatus } from "./windows-job-supervisor.js"
import { supervisorBackoffs, type WindowsSupervisorRecord } from "./supervisor-record.js"
import type { WindowsJob } from "./windows-job.js"

const loop = { pid: 123, start: "456", bootId: "windows-boot:42" }
const input = () => ({ loop, registrationId: randomUUID(), configurationDigest: "a".repeat(64), signal: new AbortController().signal })
function fixture(codes = [9, 9, 9, 9]) {
  const records: WindowsSupervisorRecord[] = []
  const wait = vi.fn(async () => {})
  const launch = vi.fn(async (attempt: WindowsSupervisorRecord["attempts"][number]): Promise<WindowsJob> => {
    const code = codes.shift() ?? 0
    const prepared = { kind: "prepared" as const, job: attempt.job, bootId: loop.bootId, child: { ...loop, pid: 200 + attempt.number },
      helper: { ...loop, pid: 300 + attempt.number }, killOnClose: true as const, stdioOnly: true as const }
    const empty = { kind: "empty" as const, job: attempt.job, bootId: loop.bootId, code, stopped: false, terminated: true as const, activeProcesses: 0 as const }
    return { prepared, resume: async () => {
      expect(records.at(-1)?.attempts.at(-1)).toMatchObject({ stage: "prepared", child: prepared.child })
    }, exited: Promise.resolve(empty), stop: async () => ({ ...empty, stopped: true }) }
  })
  return { records, effects: { now: () => new Date(), write: (record: WindowsSupervisorRecord) => { records.push(structuredClone(record)) }, launch, wait } }
}

it("writes intent before launch and exhausts after exactly four crashes using shared backoffs", async () => {
  const f = fixture()
  const realLaunch = f.effects.launch
  f.effects.launch = vi.fn(async (attempt) => {
    expect(f.records.at(-1)?.attempts.at(-1)).toMatchObject({ stage: "intent", job: attempt.job })
    return realLaunch(attempt)
  })
  const record = await superviseWindows(input(), f.effects)
  expect(record).toMatchObject({ state: "exhausted", crashes: 4 })
  expect(record.attempts).toHaveLength(4)
  expect(f.effects.wait.mock.calls.map((args: unknown[]) => args[0])).toEqual([...supervisorBackoffs])
  expect(new Set(record.attempts.map((a) => a.job)).size).toBe(4)
  expect(() => assertWindowsTreeProof(record, loop.bootId)).not.toThrow()
  expect(windowsSupervisorStatus(record, loop.bootId, false)).toMatchObject({ running: false, supervisionFailure: "exhausted" })
})

it("does not restart after a clean exit", async () => {
  const f = fixture([0])
  expect(await superviseWindows(input(), f.effects)).toMatchObject({ state: "stopped", reason: "clean-exit" })
  expect(f.effects.launch).toHaveBeenCalledTimes(1)
  expect(f.effects.wait).not.toHaveBeenCalled()
})

it("retains unknown tree evidence and refuses restart when the helper dies", async () => {
  const f = fixture()
  f.effects.launch = vi.fn(async () => { throw new Error("helper died") })
  const record = await superviseWindows(input(), f.effects)
  expect(record).toMatchObject({ state: "failed", reason: "observation-failure" })
  expect(record.attempts).toHaveLength(1)
  expect(() => assertWindowsTreeProof(record, loop.bootId)).toThrow("Restart Windows")
  expect(windowsSupervisorStatus(record, loop.bootId, false)).toMatchObject({ running: false, supervisionFailure: "observation-failure", detail: expect.stringContaining("Restart Windows") })
  expect(() => assertWindowsTreeProof(record, "windows-boot:43")).not.toThrow()
  expect(() => assertWindowsTreeProof(record, "")).toThrow()
})

it("cancels backoff on deliberate stop without another attempt", async () => {
  const controller = new AbortController()
  const f = fixture()
  f.effects.wait = vi.fn(async () => { controller.abort() })
  const record = await superviseWindows({ ...input(), signal: controller.signal }, f.effects)
  expect(record).toMatchObject({ state: "stopped", reason: "deliberate-stop" })
  expect(record.attempts).toHaveLength(1)
})

it("never resumes when publishing the prepared identity fails", async () => {
  const f = fixture()
  const resume = vi.fn(async () => {})
  const realLaunch = f.effects.launch
  f.effects.launch = vi.fn(async (attempt) => ({ ...await realLaunch(attempt), resume }))
  const write = f.effects.write
  f.effects.write = (record) => {
    if (record.attempts.at(-1)?.stage === "prepared") throw new Error("disk unavailable")
    write(record)
  }
  const record = await superviseWindows(input(), f.effects)
  expect(resume).not.toHaveBeenCalled()
  expect(record.state).toBe("failed")
})

it("permits retry after a prelaunch failure left only a claimable lease", () => {
  expect(() => assertWindowsStartup(undefined, loop.bootId, () => false)).not.toThrow()
})

it("gates startup on every old job, and refuses a live predecessor even with empty jobs", async () => {
  const f = fixture([0])
  const record = await superviseWindows(input(), f.effects)
  record.state = "stopping"; record.reason = null
  expect(() => assertWindowsStartup(record, loop.bootId, () => true)).toThrow("still alive")
  expect(() => assertWindowsStartup(record, loop.bootId, () => { throw new Error("Access denied") })).toThrow("Access denied")
  expect(() => assertWindowsStartup(record, loop.bootId, () => false)).not.toThrow()
  const attempt = record.attempts[0]!
  attempt.stage = "running"; attempt.empty = null; attempt.exitCode = null
  record.state = "failed"; record.reason = "observation-failure"
  expect(() => assertWindowsStartup(record, loop.bootId, () => false)).toThrow("Restart Windows")
  expect(() => assertWindowsStartup(record, "windows-boot:43", () => { throw new Error("old PID must not be queried") })).not.toThrow()
})

it.each([
  ["stopped", "empty"], ["failed", "empty"], ["exhausted", "empty"],
  ["stopped", "closed"], ["failed", "closed"],
  ["stopped", "no-attempts"], ["failed", "no-attempts"],
] as const)("starts after %s history with %s proof without probing a reused loop PID", async (state, proof) => {
  const f = fixture(state === "exhausted" ? undefined : [0])
  const record = await superviseWindows(input(), f.effects)
  record.state = state
  record.reason = state === "failed" ? "observation-failure" : state === "exhausted" ? "restart-limit" : "deliberate-stop"
  if (proof === "no-attempts") record.attempts = []
  if (proof === "closed") {
    const attempt = record.attempts[0]!
    attempt.stage = "closed"; attempt.empty = null; attempt.exitCode = null
    attempt.closure = { at: record.updatedAt, jobAbsent: true, daemonDead: true }
  }
  const alive = vi.fn(() => { throw new Error("Access denied to reused PID") })
  expect(() => assertWindowsStartup(record, loop.bootId, alive)).not.toThrow()
  expect(alive).not.toHaveBeenCalled()
})

it("reports a dead loop during backoff as failed even when the old job is empty", async () => {
  const f = fixture()
  await superviseWindows(input(), f.effects)
  const backingOff = f.records.find((r) => r.state === "backoff")!
  expect(windowsSupervisorStatus(backingOff, loop.bootId, false)).toMatchObject({ running: false, supervisionFailure: "observation-failure" })
})

it("preserves both supervision and refusal-publication failures with the caught cause", async () => {
  const f = fixture(), primary = new Error("initial publication failed"), publication = new Error("refusal publication failed")
  f.effects.write = (record) => { throw record.state === "failed" ? publication : primary }
  await expect(superviseWindows(input(), f.effects)).rejects.toMatchObject({
    errors: [primary, publication], cause: publication,
  })
})

it("persists confirmed kill-on-close in prepared attempt evidence", async () => {
  const f = fixture([0])
  await superviseWindows(input(), f.effects)
  expect(f.records.find((record) => record.attempts.at(-1)?.stage === "prepared")?.attempts[0]).toMatchObject({ killOnClose: true })
})
