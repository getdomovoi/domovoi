import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UpdateActivation, type ActivationFence, type ActivationHealth, type ActiveUpdateRuntime } from "./update-activation.js"
import { claimProfile } from "./profile-lease.js"
import { persistActivationJournal, readActivationJournal, persistTrustedUpdateMetadata, readTrustedUpdateMetadata, type ActivationJournal, type ActivationRuntime } from "./update-state.js"

const previous: ActivationRuntime = {
  version: "1.0.0", receiptDigest: "a".repeat(64), sha256: "b".repeat(64),
  sourceCommit: "c".repeat(40), runtimeLockDigest: `sha256:${"d".repeat(64)}`, path: "/fixture/v1.0.0/runtime",
}
const target: ActivationRuntime = { ...previous, version: "1.1.0", receiptDigest: "e".repeat(64), path: "/fixture/v1.1.0/runtime" }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())) })
const health = (journal: ActivationJournal, runtime: ActivationRuntime): ActivationHealth => ({
  id: journal.id, generation: journal.generation, runtime, profileOwned: true, stateReady: true, listenerReady: true, healthy: true,
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "domovoi-activation-"))
  const lease = claimProfile(home)
  cleanups.push(async () => { lease.release(); await rm(home, { recursive: true, force: true }) })
  const events: string[] = []
  let active: ActiveUpdateRuntime = { revision: randomUUID(), runtime: previous }
  let held = false
  let owned = true
  let lastHealth: ActivationHealth | undefined
  const fence: ActivationFence = {
    generation: "generation-1",
    assertHeld: () => { if (!held || !owned) throw new Error("Fence lost") },
    release: vi.fn(() => { held = false }),
    readJournal: async () => readActivationJournal(home),
    writeJournal: async (value) => { fence.assertHeld(); await persistActivationJournal(home, lease, value); events.push(value.phase) },
    active: async () => active, verify: async () => true, qualified: async () => true,
    switch: async (expected, next) => { fence.assertHeld(); expect(active).toEqual(expected); events.push("switch"); active = next },
    restore: async (expected, next) => { fence.assertHeld(); expect(active).toEqual(expected); events.push("restore"); active = next },
    start: async (journal, runtime) => { fence.assertHeld(); events.push(`start:${runtime.version}`); lastHealth = health(journal, runtime); return lastHealth },
    health: async () => lastHealth,
  }
  const options = { acquire: vi.fn(async () => { if (held) return undefined; held = true; return fence }), timeoutMs: 5000, startupTimeoutMs: 1000 }
  return { home, lease, events, fence, options, coordinator: new UpdateActivation(options), active: () => active,
    setActive: (value: ActiveUpdateRuntime) => { active = value }, loseFence: () => { owned = false }, held: () => held,
    journal: () => readActivationJournal(home)!, }
}

describe("isolated update activation", () => {
  it("commits only after durable intent, fenced switching and matching startup health", async () => {
    const f = await fixture()
    expect(await f.coordinator.activate(target)).toEqual({ state: "committed" })
    expect(f.events).toEqual(["prepared", "switch", "starting", "start:1.1.0", "committed"])
    expect(f.journal().phase).toBe("committed")
    expect(f.active()).toEqual({ revision: f.journal().id, runtime: target })
    expect(f.fence.release).toHaveBeenCalledTimes(1)
  })
  it("defers when the external idle fence refuses acquisition, before any effect", async () => {
    const f = await fixture()
    const coordinator = new UpdateActivation({ ...f.options, acquire: async () => undefined })
    expect(await coordinator.activate(target)).toEqual({ state: "deferred" })
    expect(f.events).toEqual([])
  })
  it("refuses missing qualification or changed immutable bytes before switching", async () => {
    const f = await fixture()
    f.fence.qualified = async () => false
    expect(await f.coordinator.activate(target)).toEqual({ state: "deferred" })
    f.fence.qualified = async () => true
    f.fence.verify = async () => false
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.events).toEqual([])
  })
  it("refuses an unqualified rollback runtime before switching to a qualified target", async () => {
    const f = await fixture()
    f.fence.qualified = async (runtime) => runtime.version === target.version
    expect(await f.coordinator.activate(target)).toEqual({ state: "deferred" })
    expect(f.events).toEqual([])
  })
  it.each(["id", "generation", "runtime", "profileOwned", "stateReady", "listenerReady", "healthy"] as const)("rolls back a startup receipt with wrong %s", async (field) => {
    const f = await fixture()
    f.fence.start = async (journal, runtime) => {
      const receipt = health(journal, runtime)
      if (runtime.version === target.version) {
        if (field === "runtime") receipt.runtime = previous
        else if (field === "id" || field === "generation") receipt[field] = "stale"
        else receipt[field] = false
      }
      return receipt
    }
    expect(await f.coordinator.activate(target)).toEqual({ state: "rolled-back" })
    expect(f.active()).toEqual({ revision: f.journal().rollbackRevision, runtime: previous })
  })
  it.each(["prepared", "starting", "committed"] as const)("stops after failed %s publication, then reconciles fresh durable state", async (phase) => {
    const f = await fixture()
    const write = f.fence.writeJournal
    f.fence.writeJournal = async (record, signal) => { if (record.phase === phase) throw new Error("write failed"); await write(record, signal) }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    if (phase === "prepared") expect(f.events).toEqual([])
    if (phase === "starting") expect(f.events).toEqual(["prepared", "switch"])
    if (phase === "committed") expect(f.events).toEqual(["prepared", "switch", "starting", "start:1.1.0"])
    f.fence.writeJournal = write
    expect((await new UpdateActivation(f.options).recover()).state).toBe(phase === "prepared" ? "deferred" : "rolled-back")
  })
  it.each(["prepared", "starting", "committed", "rollback", "restarting", "rolled-back"] as const)("recovers a crash after durable %s publication without replaying launch", async (phase) => {
    const f = await fixture()
    if (["rollback", "restarting", "rolled-back"].includes(phase)) f.fence.start = async (journal, runtime) => runtime.version === target.version ? undefined : health(journal, runtime)
    const write = f.fence.writeJournal
    f.fence.writeJournal = async (record, signal) => { await write(record, signal); if (record.phase === phase) throw new Error("crash after publication") }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.journal().phase).toBe(phase)
    f.fence.writeJournal = write
    const starts = vi.spyOn(f.fence, "start")
    expect((await new UpdateActivation(f.options).recover()).state).toBe(phase === "committed" ? "committed" : phase === "restarting" ? "quarantined" : "rolled-back")
    if (["prepared", "committed", "restarting", "rolled-back"].includes(phase)) expect(starts).not.toHaveBeenCalled()
    await new UpdateActivation(f.options).recover()
    expect(starts.mock.calls.length).toBeLessThanOrEqual(1)
  })
  it.each(["before", "after"])("quarantines a foreign active revision after switch failure %s CAS", async (when) => {
    const f = await fixture()
    const change = f.fence.switch
    f.fence.switch = async (...args) => { if (when === "after") await change(...args); throw new Error("switch crash") }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    f.setActive({ ...f.active(), revision: randomUUID() })
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "quarantined" })
    expect(f.events).not.toContain("restore")
  })
  it("does not retry ambiguous rollback launch or revert a committed runtime", async () => {
    const f = await fixture()
    f.fence.start = async () => undefined
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.journal().phase).toBe("restarting")
    f.fence.health = async () => undefined
    const start = vi.spyOn(f.fence, "start")
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "quarantined" })
    expect(start).not.toHaveBeenCalled()
    f.fence.health = async (journal, runtime) => health(journal, runtime)
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "rolled-back" })
    f.fence.start = async (journal, runtime) => health(journal, runtime)
    expect(await f.coordinator.activate(target)).toEqual({ state: "committed" })
    f.fence.health = async () => undefined
    const restore = vi.spyOn(f.fence, "restore")
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "committed" })
    expect(restore).not.toHaveBeenCalled()
  })
  it.each(["before", "after"])("reconciles failed restoration %s CAS without launching before durable intent", async (when) => {
    const f = await fixture()
    f.fence.start = async (journal, runtime) => runtime.version === target.version ? undefined : health(journal, runtime)
    const restore = f.fence.restore
    f.fence.restore = async (...args) => { if (when === "after") await restore(...args); throw new Error("restore failed") }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.journal().phase).toBe("rollback")
    const start = vi.spyOn(f.fence, "start")
    f.fence.restore = restore
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "rolled-back" })
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[0].phase).toBe("restarting")
  })
  it.each(["journal", "switch", "start"])("refuses subsequent effects after fence loss at awaited %s boundary", async (boundary) => {
    const f = await fixture()
    if (boundary === "journal") {
      const write = f.fence.writeJournal
      f.fence.writeJournal = async (...args) => { await write(...args); f.loseFence() }
    } else if (boundary === "switch") {
      const change = f.fence.switch
      f.fence.switch = async (...args) => { await change(...args); f.loseFence() }
    } else {
      const start = f.fence.start
      f.fence.start = async (...args) => { const result = await start(...args); f.loseFence(); return result }
    }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.journal().phase).toBe(boundary === "start" ? "starting" : "prepared")
    expect(f.events).not.toContain("restore")
    expect(f.events).not.toContain("committed")
  })
  it("retains the fence and refuses concurrency until a timed-out switch settles", async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const change = f.fence.switch
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    f.fence.switch = async (...args) => { entered(); await gate; await change(...args) }
    const coordinator = new UpdateActivation(f.options)
    const attempt = coordinator.activate(target)
    await entry
    await vi.advanceTimersByTimeAsync(5000)
    expect(await attempt).toEqual({ state: "quarantined" })
    expect(f.held()).toBe(true)
    expect(f.fence.release).not.toHaveBeenCalled()
    expect(await coordinator.recover()).toEqual({ state: "busy" })
    release()
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.held()).toBe(false), { timeout: 1000 })
    expect(f.events).toEqual(["prepared", "switch"])
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "rolled-back" })
  })
  it("releases a late acquired fence without performing work", async () => {
    const f = await fixture()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const coordinator = new UpdateActivation({ ...f.options, timeoutMs: 20, startupTimeoutMs: 10, acquire: async () => { await gate; return f.options.acquire() } })
    expect(await coordinator.activate(target)).toEqual({ state: "quarantined" })
    finish()
    await vi.waitFor(() => expect(f.fence.release).toHaveBeenCalledTimes(1), { timeout: 1000 })
    expect(f.events).toEqual([])
  })
  it("quarantines a startup that ignores watchdog cancellation until it settles, then permits explicit recovery", async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    let settle!: () => void
    const gate = new Promise<void>((resolve) => { settle = resolve })
    f.fence.start = async (journal, runtime) => {
      if (runtime.version === target.version) { entered(); await gate }
      return health(journal, runtime)
    }
    const result = f.coordinator.activate(target)
    await entry
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toEqual({ state: "quarantined" })
    expect(f.held()).toBe(true)
    expect(f.events).not.toContain("restore")
    settle()
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.held()).toBe(false), { timeout: 1000 })
    expect(f.journal().phase).toBe("starting")
    expect(await new UpdateActivation(f.options).recover()).toEqual({ state: "rolled-back" })
  })
  it("rejects invalid/backward clocks and fence loss after an await", async () => {
    const f = await fixture()
    const times = [100, 99]
    expect(await new UpdateActivation({ ...f.options, now: () => times.shift() ?? 99 }).activate(target)).toEqual({ state: "quarantined" })
    expect(await new UpdateActivation({ ...f.options, now: () => NaN }).activate(target)).toEqual({ state: "quarantined" })
    f.fence.qualified = async () => { f.loseFence(); return true }
    expect(await f.coordinator.activate(target)).toEqual({ state: "quarantined" })
    expect(f.events).toEqual([])
  })
  it("aborts the startup watchdog, waits for settlement, then restores the exact previous runtime", async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    let cancelled = false
    f.fence.start = async (journal, runtime, signal) => {
      if (runtime.version !== target.version) return health(journal, runtime)
      signal.addEventListener("abort", () => { cancelled = true }, { once: true })
      entered()
      await settled
      return health(journal, runtime) // Late health after watchdog expiry cannot commit.
    }
    const result = f.coordinator.activate(target)
    await entry
    await vi.advanceTimersByTimeAsync(1000)
    expect(cancelled).toBe(true)
    expect(f.held()).toBe(true)
    expect(f.events).not.toContain("restore")
    settle()
    expect(await result).toEqual({ state: "rolled-back" })
    expect(f.active()).toEqual({ revision: f.journal().rollbackRevision, runtime: previous })
  })
  it("refuses late startup health even when the timer callback has not run", async () => {
    const f = await fixture()
    let now = 0
    f.fence.start = async (journal, runtime) => {
      if (runtime.version === target.version) now += f.options.startupTimeoutMs + 1
      return health(journal, runtime)
    }
    expect(await new UpdateActivation({ ...f.options, now: () => now }).activate(target)).toEqual({ state: "rolled-back" })
    expect(f.events).not.toContain("committed")
  })
  it.each([0, 7])("uses an isolated child startup receipt/exit (%s) before committing or restoring", async (code) => {
    const f = await fixture()
    f.fence.start = async (journal, runtime, signal) => {
      if (runtime.version !== target.version) return health(journal, runtime)
      return new Promise<ActivationHealth | undefined>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e",
          "process.stdout.write(process.argv[1]); process.exit(Number(process.argv[2]))", JSON.stringify(health(journal, runtime)), String(code)],
        { env: {}, stdio: ["ignore", "pipe", "ignore"] })
        const cancel = () => { child.kill() }
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
        let output = ""
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4096) cancel() })
        child.on("error", reject)
        child.on("close", (exit) => {
          signal.removeEventListener("abort", cancel)
          resolve(exit === 0 && !signal.aborted ? JSON.parse(output) as ActivationHealth : undefined)
        })
      })
    }
    expect(await f.coordinator.activate(target)).toEqual({ state: code === 0 ? "committed" : "rolled-back" })
  })
  it("does not roll back TUF trust when runtime startup fails", async () => {
    const f = await fixture()
    const trust = { format: 1 as const, rootVersion: 4, rootDigest: "root", timestampVersion: 5, timestampDigest: "ts", snapshotVersion: 6, snapshotDigest: "snap", targetsVersion: 7, targetsDigest: "targets" }
    await persistTrustedUpdateMetadata(f.home, f.lease, trust)
    f.fence.start = async (journal, runtime) => runtime.version === target.version ? undefined : health(journal, runtime)
    expect(await f.coordinator.activate(target)).toEqual({ state: "rolled-back" })
    expect(await readTrustedUpdateMetadata(f.home)).toEqual(trust)
  })
})
