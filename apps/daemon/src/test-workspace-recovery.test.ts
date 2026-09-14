import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"
import { holdRecoveryWriter, recoveryFixtureBudgets, runRecoveryPhase } from "./test-workspace-recovery.js"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("workspace recovery fixture lifetime", () => {
  it("gives ancestry its full phase after two slow fixture startups", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const budgets = recoveryFixtureBudgets(25_000)
    const sequence = OperationDeadline.start(budgets.sequenceMs)
    try {
      for (const phase of ["owner startup", "writer startup", "ancestry"] as const) {
        await runRecoveryPhase(phase, sequence, budgets.phaseMs, async (deadline) => {
          expect(deadline.remainingMs()).toBe(25_000)
          await vi.advanceTimersByTimeAsync(24_000)
          expect(deadline.signal.aborted).toBe(false)
        })
      }
      expect(sequence.signal.aborted).toBe(false)
    } finally { sequence.clear() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses a stuck ancestry phase and still gives cleanup its own deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const budgets = recoveryFixtureBudgets(25_000)
    const sequence = OperationDeadline.start(budgets.sequenceMs)
    try {
      let refused = false
      const failure = runRecoveryPhase("ancestry", sequence, budgets.phaseMs, () => new Promise(() => {}))
        .catch((error: unknown) => { refused = true; return error })
      await vi.advanceTimersByTimeAsync(budgets.phaseMs)
      expect(refused).toBe(true)
      expect(await failure).toMatchObject({ message: expect.stringContaining("during ancestry"), cause: expect.any(OperationDeadlineExceededError) })
      await vi.advanceTimersByTimeAsync(budgets.sequenceMs)
      const cleanup = OperationDeadline.start(budgets.cleanupMs)
      try {
        await runRecoveryPhase("cleanup", cleanup, budgets.cleanupMs, async (deadline) => {
          await vi.advanceTimersByTimeAsync(budgets.cleanupMs - 1)
          deadline.throwIfExpired()
        })
      } finally { cleanup.clear() }
    } finally { sequence.clear() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["release", "watchdog"])("keeps the writer through the sequence, then stops by %s", async (ending) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-recovery-lifetime-"))
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
    const expired = vi.fn()
    const budgets = recoveryFixtureBudgets(25_000)
    const stop = holdRecoveryWriter(root, budgets.holderMs, expired)
    try {
      await vi.advanceTimersByTimeAsync(budgets.sequenceMs)
      expect(expired).not.toHaveBeenCalled()
      if (ending === "release") {
        await writeFile(join(root, "child-release"), "finish")
        await vi.advanceTimersByTimeAsync(25)
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(budgets.holderMs)
        expect(expired).not.toHaveBeenCalled()
      } else {
        await vi.advanceTimersByTimeAsync(budgets.cleanupMs + budgets.reapMs)
        expect(expired).toHaveBeenCalledExactlyOnceWith()
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally { stop(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
  })
})
