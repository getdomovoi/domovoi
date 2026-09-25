import { describe, expect, it } from "vitest"

import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  formatTokenCount,
  sessionUsageFetchKey,
  maximumTimeoutMs,
  usageTodayRefreshDelayMs,
  usageTodayWindow,
  usageWindowFetchKey,
} from "./session-usage"

describe("session usage formatting", () => {
  it("keeps small token counts exact and compacts large ones", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(900)).toBe("900")
    expect(formatTokenCount(1_200)).toBe("1.2k")
    expect(formatTokenCount(12_000)).toBe("12k")
    expect(formatTokenCount(42_140)).toBe("42.1k")
    expect(formatTokenCount(124_000)).toBe("124k")
    expect(formatTokenCount(1_250_000)).toBe("1.3M")
  })
})

describe("session usage refresh", () => {
  function snapshot(activeTurnId: string | null, activeSessionId: string | null = "session-1") {
    return {
      activeSessionId,
      sessions: [{ id: "session-1", activeTurnId }],
    } as unknown as WorkspaceSnapshot
  }

  it("refetches when a session is activated and again when its turn completes", () => {
    expect(sessionUsageFetchKey(null)).toBeNull()
    expect(sessionUsageFetchKey(snapshot(null, null))).toBeNull()
    expect(sessionUsageFetchKey(snapshot(null))).toBe("session-1:idle")
    expect(sessionUsageFetchKey(snapshot("turn-7"))).toBe("session-1:turn-7")
    expect(sessionUsageFetchKey(snapshot(null))).not.toBe(sessionUsageFetchKey(snapshot("turn-7")))
  })
})

describe("usage today", () => {
  it("spans the local calendar day the clock is in", () => {
    const now = new Date(2026, 8, 4, 15, 30)
    const today = usageTodayWindow(now)
    expect(today).toEqual({
      start: new Date(2026, 8, 4).toISOString(),
      end: new Date(2026, 8, 5).toISOString(),
    })
    expect(Date.parse(today.start)).toBeLessThanOrEqual(now.getTime())
    expect(Date.parse(today.end)).toBeGreaterThan(now.getTime())
  })

  it("waits until the next local midnight, never longer than a timer accepts", () => {
    expect(usageTodayRefreshDelayMs(new Date(2026, 8, 4, 23, 59, 30))).toBe(30_000)
    expect(usageTodayRefreshDelayMs(new Date(2026, 8, 4, 0, 0, 0))).toBe(
      new Date(2026, 8, 5).getTime() - new Date(2026, 8, 4).getTime(),
    )
    expect(usageTodayRefreshDelayMs(new Date(2026, 8, 4, 12))).toBeLessThanOrEqual(maximumTimeoutMs)
    expect(maximumTimeoutMs).toBe(2_147_483_647)
  })

  it("refetches when any session starts or finishes a turn", () => {
    const snapshot = (sessions: Array<{ id: string; activeTurnId: string | null }>) => (
      { activeSessionId: null, sessions } as unknown as WorkspaceSnapshot
    )
    expect(usageWindowFetchKey(null)).toBeNull()
    expect(usageWindowFetchKey(snapshot([]))).toBe("idle")
    const idle = usageWindowFetchKey(snapshot([{ id: "a", activeTurnId: null }, { id: "b", activeTurnId: null }]))
    const busy = usageWindowFetchKey(snapshot([{ id: "a", activeTurnId: null }, { id: "b", activeTurnId: "turn-2" }]))
    expect(idle).not.toBe(busy)
    expect(usageWindowFetchKey(snapshot([{ id: "a", activeTurnId: null }, { id: "b", activeTurnId: null }]))).toBe(idle)
  })
})
