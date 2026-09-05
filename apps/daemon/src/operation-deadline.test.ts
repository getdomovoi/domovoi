import { afterEach, describe, expect, it, vi } from "vitest"

import { beforeDeadline, OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

afterEach(() => vi.useRealTimers())

describe("OperationDeadline", () => {
  it("bounds an unanswered operation and refuses a late result even before the timer runs", async () => {
    vi.useFakeTimers()
    let now = 0
    const deadline = OperationDeadline.start(100, { now: () => now })
    const pending = beforeDeadline(new Promise(() => {}), deadline)
    const expired = expect(pending).rejects.toThrow(OperationDeadlineExceededError)
    await vi.advanceTimersByTimeAsync(100)
    await expired
    const second = OperationDeadline.start(100, { now: () => now })
    now = 101
    await expect(beforeDeadline(Promise.resolve("late"), second)).rejects.toThrow(OperationDeadlineExceededError)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([0, -1, Infinity, NaN, 2_147_483_648])("refuses an unbounded or invalid budget %s", (budget) => {
    expect(() => OperationDeadline.start(budget)).toThrow(RangeError)
  })

  it("uses one monotonic budget across phases and does not rely on a timer firing", () => {
    let now = 100
    const deadline = OperationDeadline.start(100, { now: () => now })
    expect(deadline.remainingMs()).toBe(100)
    now += 70
    expect(deadline.remainingMs()).toBe(30)
    const child = deadline.limit(1_000)
    expect(child.remainingMs()).toBe(30)
    now += 31
    expect(() => child.throwIfExpired()).toThrow(OperationDeadlineExceededError)
    expect(child.signal.aborted).toBe(true)
    expect(() => deadline.throwIfExpired()).toThrow(OperationDeadlineExceededError)
    deadline.clear()
    child.clear()
  })

  it("cancels waiting phases at expiry and removes their timers", async () => {
    vi.useFakeTimers()
    const deadline = OperationDeadline.start(100)
    const child = deadline.limit(1_000)
    const expired = vi.fn()
    child.signal.addEventListener("abort", expired, { once: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(expired).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(deadline.remainingMs()).toBe(0)
  })

  it("propagates cancellation, including one that preceded resource creation", () => {
    vi.useFakeTimers()
    const cancelled = new AbortController()
    const deadline = OperationDeadline.start(1_000, { signal: cancelled.signal })
    const child = deadline.limit(1_000)
    cancelled.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(child.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => child.throwIfExpired()).toThrow("cancelled")
    const alreadyCancelled = OperationDeadline.start(1_000, { signal: cancelled.signal })
    expect(() => alreadyCancelled.throwIfExpired()).toThrow("cancelled")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears resources after success without inventing an expiry", () => {
    vi.useFakeTimers()
    const parent = OperationDeadline.start(1_000)
    const child = parent.limit(100)
    child.clear()
    parent.clear()
    expect(vi.getTimerCount()).toBe(0)
    expect(child.signal.aborted).toBe(false)
    expect(parent.signal.aborted).toBe(false)
  })
})
