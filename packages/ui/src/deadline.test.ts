import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Deadline, DeadlineExceededError, describeTarget } from "./deadline"

describe("Deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("expires once its whole budget has elapsed", async () => {
    const deadline = Deadline.start(1_000)
    const expired = vi.fn()
    deadline.signal.addEventListener("abort", expired)

    await vi.advanceTimersByTimeAsync(999)
    expect(deadline.expired).toBe(false)
    expect(deadline.remainingMs()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(deadline.expired).toBe(true)
    expect(deadline.remainingMs()).toBe(0)
    expect(expired).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses a budget that is not finite and positive", () => {
    expect(() => Deadline.start(0)).toThrow(RangeError)
    expect(() => Deadline.start(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => Deadline.start(2_147_483_648)).toThrow(RangeError)
  })

  it("holds a phase to the remaining budget, never more", async () => {
    const deadline = Deadline.start(1_000)
    await vi.advanceTimersByTimeAsync(700)

    const phase = deadline.limit(5_000)
    expect(phase.budgetMs).toBe(300)
    await vi.advanceTimersByTimeAsync(300)

    expect(phase.expired).toBe(true)
    expect(deadline.expired).toBe(true)
  })

  it("lets a phase be stricter than the whole", async () => {
    const deadline = Deadline.start(10_000)
    const phase = deadline.limit(100)

    await vi.advanceTimersByTimeAsync(100)

    expect(phase.expired).toBe(true)
    expect(deadline.expired).toBe(false)
    deadline.clear()
  })

  it("starts a phase already expired when the whole has run out", async () => {
    const deadline = Deadline.start(100)
    await vi.advanceTimersByTimeAsync(100)

    expect(deadline.limit(100).expired).toBe(true)
  })

  it("clears its timer without counting as expiry", async () => {
    const deadline = Deadline.start(100)
    const phase = deadline.limit(50)

    phase.clear()
    deadline.clear()
    await vi.advanceTimersByTimeAsync(100)

    expect(deadline.expired).toBe(false)
    expect(phase.expired).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("names the stage and a sanitized target when it fails", () => {
    const error = new DeadlineExceededError("open", describeTarget("wss://user:secret@machine.example:47831/rpc?token=abc"), 5_000)

    expect(error.message).toBe("Timed out after 5000ms during open of wss://machine.example:47831/rpc")
    expect(error).toMatchObject({ stage: "open", budgetMs: 5_000 })
    expect(describeTarget("not a url")).toBe("endpoint")
  })
})
