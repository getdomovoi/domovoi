import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { beforeDeadline, OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"
import { cleanupRecoveryWriters, waitForRecoveryCondition } from "./test-workspace-recovery.js"
import { fixtureStartupTimeoutMs } from "./test-wait-for.js"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("workspace recovery fixture cleanup", () => {
  it("force-reaps a real writer that ignores release", async () => {
    const budgetMs = fixtureStartupTimeoutMs(process.platform)
    const startup = OperationDeadline.start(budgetMs)
    const child = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); process.send("ready")'], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const isAlive = (pid: number) => {
      try { process.kill(pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    try {
      await beforeDeadline(new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("message", () => resolve())
      }), startup)
      startup.clear()
      const stop = vi.fn(() => { child.kill("SIGKILL") })
      await expect(cleanupRecoveryWriters({
        pids: () => [child.pid!], isAlive, forceStops: [stop], release: async () => {}, exited,
      }, 50, budgetMs)).rejects.toMatchObject({ cause: expect.any(OperationDeadlineExceededError) })
      expect(stop).toHaveBeenCalledExactlyOnceWith()
      expect(isAlive(child.pid!)).toBe(false)
    } finally {
      startup.clear()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      const cleanup = OperationDeadline.start(budgetMs)
      try { if (child.pid !== undefined) await beforeDeadline(exited, cleanup) } finally { cleanup.clear() }
    }
  }, fixtureStartupTimeoutMs(process.platform) * 4)

  it("forces the real holder through its private stop path", async () => {
    const budgetMs = fixtureStartupTimeoutMs(process.platform)
    const root = await mkdtemp(join(tmpdir(), "domovoi-recovery-private-stop-"))
    const startup = OperationDeadline.start(budgetMs)
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./workspace-recovery.fixture.ts", import.meta.url)), root, "", "", "hold-child", String(budgetMs * 3),
    ], { stdio: ["ignore", "ignore", "ignore"] })
    let spawnError: Error | undefined
    child.once("error", (error) => { spawnError = error })
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
    try {
      await waitForRecoveryCondition(startup, async () => {
        if (spawnError) throw spawnError
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Holder exited before its ready record")
        let ready: unknown
        try { ready = JSON.parse(await readFile(join(root, "child-ready"), "utf8")) as unknown } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false
          throw error
        }
        expect(ready).toMatchObject({ pid: child.pid })
        return true
      })
      startup.clear()
      await expect(cleanupRecoveryWriters({
        pids: () => [child.pid!], isAlive: () => child.exitCode === null && child.signalCode === null,
        forceStops: [() => { writeFileSync(join(root, "child-force-stop"), "stop") }],
        release: async () => {}, exited,
      }, 50, budgetMs)).rejects.toMatchObject({ cause: expect.any(OperationDeadlineExceededError) })
      expect(JSON.parse(await readFile(join(root, "child-forced"), "utf8"))).toEqual({ pid: child.pid })
      expect(child.exitCode === null && child.signalCode === null).toBe(false)
      expect(await exited).not.toMatchObject({ code: 0 })
      await expect(readFile(join(root, "child-expired"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      startup.clear()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      const cleanup = OperationDeadline.start(budgetMs)
      try { if (child.pid !== undefined) await beforeDeadline(exited, cleanup) } finally { cleanup.clear() }
      await rm(root, { recursive: true, force: true })
    }
  }, fixtureStartupTimeoutMs(process.platform) * 4)

  it("cancels polling when its deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const deadline = OperationDeadline.start(40)
    const ready = vi.fn(() => false)
    try {
      const failure = waitForRecoveryCondition(deadline, ready).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(40)
      expect(await failure).toBeInstanceOf(OperationDeadlineExceededError)
      const calls = ready.mock.calls.length
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(ready).toHaveBeenCalledTimes(calls)
    } finally { deadline.clear() }
  })

  it("uses every owned stop after graceful cleanup expires, reaps, and retains the failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const live = new Set([11, 12, 13])
    const kill = vi.fn((pid: number) => { live.delete(pid) })
    const failure = cleanupRecoveryWriters({
      pids: () => [11, 12, 13], isAlive: (pid) => live.has(pid), forceStops: [() => kill(11), () => kill(12), () => kill(13)],
      release: async () => {}, exited: undefined,
    }, 50, 50).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(kill.mock.calls).toEqual([[11], [12], [13]])
    expect(live.size).toBe(0)
    expect(await failure).toMatchObject({ cause: expect.any(OperationDeadlineExceededError) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("tries the remaining writers after a kill error and bounds a failed reap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const primary = new Error("release denied")
    const denied = Object.assign(new Error("kill denied"), { code: "EPERM" })
    const live = new Set([11, 12])
    const kill = vi.fn((pid: number) => { if (pid === 11) throw denied; live.delete(pid) })
    let reported = false
    const failure = cleanupRecoveryWriters({
      pids: () => [11, 12], isAlive: (pid) => live.has(pid), forceStops: [() => kill(11), () => kill(12)],
      release: async () => { throw primary }, exited: undefined,
    }, 50, 50).catch((error: unknown) => { reported = true; return error })
    await vi.advanceTimersByTimeAsync(50)
    expect(kill.mock.calls).toEqual([[11], [12]])
    expect(live.has(12)).toBe(false)
    expect(reported).toBe(true)
    const error = await failure as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toMatchObject([
      { cause: primary }, denied, { cause: expect.any(OperationDeadlineExceededError) },
    ])
    expect(error.cause).toBe(error.errors[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["ESRCH", "EIO"])("classifies kill refusal %s without skipping other writers", async (code) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const primary = new Error("release denied")
    const refusal = Object.assign(new Error("kill failed"), { code })
    const kill = vi.fn((pid: number) => { if (pid === 11) throw refusal })
    const error = await cleanupRecoveryWriters({
      pids: () => [11, 12], isAlive: () => false, forceStops: [() => kill(11), () => kill(12)],
      release: async () => { throw primary }, exited: undefined,
    }, 50, 50).catch((failure: unknown) => failure)
    expect(kill.mock.calls).toEqual([[11], [12]])
    if (code === "ESRCH") {
      expect(error).not.toBeInstanceOf(AggregateError)
      expect(error).toMatchObject({ cause: primary })
    } else {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toMatchObject([{ cause: primary }, refusal])
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never turns a live recorded PID into termination authority", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    const stopped = vi.fn()
    // The recorded writer has exited and 99 now belongs to another process.
    // Its liveness cannot authorize a signal. Keep the reap failure instead.
    const failure = cleanupRecoveryWriters({
      pids: () => [99], isAlive: () => true, forceStops: [stopped],
      release: async () => {}, exited: Promise.resolve(),
    }, 50, 50).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(stopped).toHaveBeenCalledExactlyOnceWith()
    expect(kill).not.toHaveBeenCalled()
    expect(await failure).toMatchObject({ errors: [
      { cause: expect.any(OperationDeadlineExceededError) },
      { cause: expect.any(OperationDeadlineExceededError) },
    ] })
    expect(vi.getTimerCount()).toBe(0)
  })
})
