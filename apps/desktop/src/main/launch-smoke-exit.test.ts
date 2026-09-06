import { afterEach, describe, expect, it, vi } from "vitest"

import { LaunchSmokeExit } from "./launch-smoke-exit.js"

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe("launch smoke exit", () => {
  it("releases the daemon before a renderer failure exits", async () => {
    const events: string[] = []
    const target = new LaunchSmokeExit(async () => { events.push("release") }, (code) => { events.push(`exit:${code}`) }, vi.fn())
    await target.finish(1)
    expect(events).toEqual(["release", "exit:1"])
  })

  it("releases once and never turns a failure into success", async () => {
    vi.useFakeTimers()
    const release = vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 20) }))
    const exit = vi.fn()
    const target = new LaunchSmokeExit(release, exit, vi.fn(), 100)
    const pending = target.finish(0)
    expect(target.finish(1)).toBe(pending)
    expect(target.finish(0)).toBe(pending)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    await pending
    expect(release).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("fails successful verification when release rejects", async () => {
    const failure = new Error("Owner release failed")
    const exit = vi.fn()
    const report = vi.fn()
    const target = new LaunchSmokeExit(async () => { throw failure }, exit, report)
    await target.finish(0)
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it("bounds a silent release and cannot exit successfully after late settlement", async () => {
    vi.useFakeTimers()
    let settle: (() => void) | undefined
    const release = vi.fn(() => new Promise<void>((resolve) => { settle = resolve }))
    const exit = vi.fn()
    const report = vi.fn()
    const target = new LaunchSmokeExit(release, exit, report, 100)
    const pending = target.finish(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "Desktop smoke daemon release timed out after 100ms" }))
    settle?.()
    await pending
    expect(exit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("checks elapsed time before accepting release, even if the timer has not run", async () => {
    vi.useFakeTimers()
    const now = vi.spyOn(performance, "now").mockReturnValue(0)
    const exit = vi.fn()
    const target = new LaunchSmokeExit(async () => { now.mockReturnValue(101) }, exit, vi.fn(), 100)
    await target.finish(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still exits if reporting the release failure also throws", async () => {
    const exit = vi.fn()
    const target = new LaunchSmokeExit(async () => { throw new Error("release") }, exit, () => { throw new Error("sink") })
    await target.finish(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([0, -1, NaN, Infinity, 2_147_483_648])("refuses an invalid release budget: %s", (budget) => {
    expect(() => new LaunchSmokeExit(vi.fn(), vi.fn(), vi.fn(), budget)).toThrow("positive bounded integer")
  })
})
