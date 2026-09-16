import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import type { UsageWindow, UsageWindowParams } from "@getdomovoi/protocol"

import { useUsageToday } from "./workspace-shell.js"

afterEach(cleanup)

function usageToday(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    sessions: 2,
    turns: 3,
    inputTokens: 900,
    cachedInputTokens: 100,
    outputTokens: 300,
    reasoningTokens: 0,
    totalTokens: 1200,
    costMicros: 4_180_000,
    currency: "USD",
    reportedCostTurns: 3,
    unavailableCostTurns: 0,
    ...overrides,
  }
}




it("refreshes the today readout at local midnight and stops on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  try {
    vi.setSystemTime(new Date(2026, 8, 4, 23, 59, 30))
    const fetch = vi.fn((_window: UsageWindowParams) => Promise.resolve(usageToday()))
    const view = renderHook(() => useUsageToday(true, "idle", fetch))
    await act(async () => { await Promise.resolve() })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenLastCalledWith({
      start: new Date(2026, 8, 4).toISOString(),
      end: new Date(2026, 8, 5).toISOString(),
    })
    expect(view.result.current).toEqual(usageToday())
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => { vi.advanceTimersByTime(30_000) })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith({
      start: new Date(2026, 8, 5).toISOString(),
      end: new Date(2026, 8, 6).toISOString(),
    })
    expect(vi.getTimerCount()).toBe(1)

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
