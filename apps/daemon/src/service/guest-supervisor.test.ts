import { randomUUID } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { superviseGuest, type GuestSupervisorEffects } from "./guest-supervisor.js"
import { supervisorRecordSchema, type SupervisorRecord } from "./supervisor-record.js"

const loop = { pid: 100, start: "1000", bootId: randomUUID() }
const identity = (pid: number) => ({ ...loop, pid, start: String(pid * 10) })
const input = () => ({ loop, registrationId: randomUUID(), configurationDigest: "a".repeat(64), signal: new AbortController().signal })

function fixture(exits: { code: number | null; signal: string | null }[]) {
  const records: SupervisorRecord[] = []
  let clock = Date.parse("2026-09-12T12:00:00Z")
  let index = 0
  const stop = vi.fn(async () => ({ code: 0, signal: null }))
  const effects: GuestSupervisorEffects = {
    now: () => new Date(clock),
    write: (record) => { records.push(supervisorRecordSchema.parse(structuredClone(record))) },
    launch: vi.fn<GuestSupervisorEffects["launch"]>(async () => ({ state: "started", child: {
      identity: identity(++index), exited: Promise.resolve(exits[index - 1]!), stop,
    } })),
    wait: vi.fn(async (ms) => { clock += ms }),
  }
  return { records, effects, stop }
}

describe("guest crash supervisor", () => {
  it("records four crashes, three bounded restarts and explicit exhaustion", async () => {
    const f = fixture(Array.from({ length: 4 }, () => ({ code: null, signal: "SIGKILL" })))
    const final = await superviseGuest(input(), f.effects)
    expect(f.effects.launch).toHaveBeenCalledTimes(4)
    expect(vi.mocked(f.effects.wait).mock.calls.map(([ms]) => ms)).toEqual([1000, 5000, 15000])
    expect(final).toMatchObject({ state: "exhausted", attemptCount: 4, crashes: 4,
      reason: { kind: "restart-limit", at: "2026-09-12T12:00:21.000Z" } })
    expect(final.attempts.map((attempt) => attempt.backoffMs)).toEqual([1000, 5000, 15000, 0])
    expect(final.attempts.map((attempt) => attempt.backoffOutcome)).toEqual(["completed", "completed", "completed", null])
    expect(final.attempts[2]?.backoffEndedAt).toBe("2026-09-12T12:00:21.000Z")
    expect(final.attempts.map((attempt) => attempt.child?.pid)).toEqual([1, 2, 3, 4])
    expect(final.attempts.every((attempt) => attempt.exit?.kind === "crash" && attempt.exit.signal === "SIGKILL")).toBe(true)
    expect(f.records[0]).toMatchObject({ state: "starting", attemptCount: 0 })
    expect(f.stop).not.toHaveBeenCalled()
  })

  it("records failed launches and their codes against the same lifetime allowance", async () => {
    const f = fixture([])
    f.effects.launch = vi.fn<GuestSupervisorEffects["launch"]>(async () => ({ state: "failed", errorCode: "ENOENT" }))
    const final = await superviseGuest(input(), f.effects)
    expect(final.state).toBe("exhausted")
    expect(final.attempts).toHaveLength(4)
    expect(final.attempts.every((attempt) => attempt.child === null && attempt.exit?.kind === "launch-failed"
      && attempt.exit.errorCode === "ENOENT")).toBe(true)
  })

  it("counts a numeric nonzero exit as a crash, then stops cleanly without another restart", async () => {
    const f = fixture([{ code: 127, signal: null }, { code: 0, signal: null }])
    const final = await superviseGuest(input(), f.effects)
    expect(final).toMatchObject({ state: "stopped", crashes: 1, attemptCount: 2, reason: { kind: "clean-exit" } })
    expect(final.attempts[0]?.exit).toMatchObject({ kind: "crash", code: 127 })
    expect(final.attempts[1]?.exit).toMatchObject({ kind: "clean", code: 0 })
    expect(f.effects.wait).toHaveBeenCalledTimes(1)
  })

  it("never restarts a first clean exit", async () => {
    const f = fixture([{ code: 0, signal: null }])
    const final = await superviseGuest(input(), f.effects)
    expect(final).toMatchObject({ state: "stopped", crashes: 0, attemptCount: 1 })
    expect(f.effects.wait).not.toHaveBeenCalled()
  })

  it("cancels backoff without another launch or another crash", async () => {
    const controller = new AbortController()
    const f = fixture([{ code: 1, signal: null }])
    f.effects.wait = vi.fn(async (_ms, signal) => { controller.abort(); signal.throwIfAborted() })
    const final = await superviseGuest({ ...input(), signal: controller.signal }, f.effects)
    expect(final).toMatchObject({ state: "stopped", crashes: 1, attemptCount: 1, reason: { kind: "deliberate-stop" } })
    expect(final.attempts[0]?.backoffOutcome).toBe("cancelled")
    expect(f.effects.launch).toHaveBeenCalledTimes(1)
  })

  it("stops and reaps a live owned child on deliberate shutdown", async () => {
    const controller = new AbortController()
    const f = fixture([])
    f.effects.launch = vi.fn<GuestSupervisorEffects["launch"]>(async () => {
      queueMicrotask(() => controller.abort())
      return { state: "started", child: { identity: identity(1), exited: new Promise(() => {}), stop: f.stop } }
    })
    const final = await superviseGuest({ ...input(), signal: controller.signal }, f.effects)
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(final).toMatchObject({ state: "stopped", crashes: 0, reason: { kind: "deliberate-stop" } })
    expect(final.attempts[0]?.exit?.kind).toBe("stopped")
    expect(f.effects.wait).not.toHaveBeenCalled()
  })

  it("refuses an unobservable initial launch", async () => {
    const f = fixture([])
    const failure = new Error("record unavailable")
    f.effects.write = () => { throw failure }
    await expect(superviseGuest(input(), f.effects)).rejects.toBe(failure)
    expect(f.effects.launch).not.toHaveBeenCalled()
  })

  it("stops the child instead of retrying when its running record cannot be written", async () => {
    const f = fixture([])
    const failure = new Error("rename failed")
    f.effects.launch = vi.fn<GuestSupervisorEffects["launch"]>(async () => ({ state: "started", child: {
      identity: identity(1), exited: new Promise(() => {}), stop: f.stop,
    } }))
    const write = f.effects.write
    f.effects.write = (record) => { if (record.state === "running") throw failure; write(record) }
    await expect(superviseGuest(input(), f.effects)).rejects.toBe(failure)
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.effects.launch).toHaveBeenCalledTimes(1)
  })

  it("preserves publication and shutdown failure in order", async () => {
    const f = fixture([])
    const primary = new Error("record failed")
    const cleanup = new Error("child stop unproved")
    f.effects.launch = vi.fn<GuestSupervisorEffects["launch"]>(async () => ({ state: "started", child: {
      identity: identity(1), exited: new Promise(() => {}), stop: async () => { throw cleanup },
    } }))
    const write = f.effects.write
    f.effects.write = (record) => { if (record.state === "running") throw primary; write(record) }
    await expect(superviseGuest(input(), f.effects)).rejects.toMatchObject({ cause: primary, errors: [primary, cleanup] })
    expect(f.effects.launch).toHaveBeenCalledTimes(1)
  })

  it("does not repeat an already failed deliberate shutdown", async () => {
    const controller = new AbortController()
    const f = fixture([])
    const failure = new Error("child shutdown unproved")
    f.stop.mockRejectedValue(failure)
    f.effects.launch = async () => {
      queueMicrotask(() => controller.abort())
      return { state: "started", child: { identity: identity(1), exited: new Promise(() => {}), stop: f.stop } }
    }
    await expect(superviseGuest({ ...input(), signal: controller.signal }, f.effects)).rejects.toBe(failure)
    expect(f.stop).toHaveBeenCalledTimes(1)
  })
})
