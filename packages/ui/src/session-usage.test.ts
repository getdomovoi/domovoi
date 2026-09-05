import { describe, expect, it } from "vitest"

import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  formatTokenCount,
  sessionContextReadout,
  sessionContextShare,
  sessionUsageFetchKey,
  formatUsageCost,
  sessionUsageCostNote,
  sessionUsageReportedCost,
  usageTodayDetail,
  usageTodayReadout,
  usageTodayWindow,
  usageWindowFetchKey,
} from "./session-usage"

function usage(overrides: Partial<Parameters<typeof sessionUsageCostNote>[0]> = {}) {
  return {
    sessionId: "session-1",
    inputTokens: 900,
    cachedInputTokens: 100,
    outputTokens: 300,
    reasoningTokens: 0,
    totalTokens: 1200,
    costMicros: 4500,
    currency: "USD",
    reportedCostTurns: 3,
    unavailableCostTurns: 0,
    byRuntime: [],
    ...overrides,
  }
}

describe("session usage formatting", () => {
  it("keeps small token counts exact and compacts large ones", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(900)).toBe("900")
    expect(formatTokenCount(1_200)).toBe("1.2k")
    expect(formatTokenCount(12_000)).toBe("12k")
    expect(formatTokenCount(1_250_000)).toBe("1.3M")
  })

  it("shows enough precision for sub-cent provider costs", () => {
    expect(formatUsageCost(4_500, "USD")).toBe("$0.0045")
    expect(formatUsageCost(2_340_000, "USD")).toBe("$2.34")
    expect(formatUsageCost(1_000_000, "EUR")).toBe("EUR 1.00")
  })
})

describe("session usage honesty", () => {
  it("reports no cost when the provider reported none", () => {
    expect(sessionUsageReportedCost(usage({ reportedCostTurns: 0, unavailableCostTurns: 4 }))).toBeUndefined()
    expect(sessionUsageReportedCost(usage({ currency: undefined }))).toBeUndefined()
    expect(sessionUsageReportedCost(usage())).toBe("$0.0045")
  })

  it("says how many turns lack a provider cost instead of implying completeness", () => {
    expect(sessionUsageCostNote(usage({ unavailableCostTurns: 0 }))).toBeUndefined()
    expect(sessionUsageCostNote(usage({ reportedCostTurns: 3, unavailableCostTurns: 1 })))
      .toBe("1 turn reported no cost, so this total is partial.")
    expect(sessionUsageCostNote(usage({ reportedCostTurns: 0, unavailableCostTurns: 4 })))
      .toBe("4 turns reported no cost, so Domovoi has no cost to show.")
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

it("reads context out only when the provider reported both numbers", () => {
  expect(sessionContextReadout({ contextTokens: 128_000, contextWindowTokens: 200_000 })).toBe("128k ctx")
  expect(sessionContextReadout({ contextTokens: 128_000 })).toBeUndefined()
  expect(sessionContextReadout({ contextWindowTokens: 200_000 })).toBeUndefined()
  expect(sessionContextReadout({})).toBeUndefined()
})

it("names the window the occupancy was measured against", () => {
  expect(sessionContextShare({ contextTokens: 128_000, contextWindowTokens: 200_000 }))
    .toBe("128k of 200k context tokens")
  expect(sessionContextShare({ contextTokens: 128_000 })).toBeUndefined()
})

describe("usage today", () => {
  function window(overrides: Partial<Parameters<typeof usageTodayReadout>[0]> = {}) {
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

  it("reads the reported cost out and falls back to tokens when no cost was reported", () => {
    expect(usageTodayReadout(window())).toBe("$4.18 today")
    expect(usageTodayReadout(window({ reportedCostTurns: 0, unavailableCostTurns: 3, costMicros: 0, currency: undefined })))
      .toBe("1.2k tokens today")
    expect(usageTodayReadout(window({ turns: 0, sessions: 0, totalTokens: 0, costMicros: 0, reportedCostTurns: 0 }))).toBeUndefined()
  })

  it("names the sessions, turns, and any turn without a cost in the detail", () => {
    expect(usageTodayDetail(window())).toBe("1.2k tokens across 3 turns in 2 sessions today.")
    expect(usageTodayDetail(window({ sessions: 1, turns: 1, reportedCostTurns: 0, unavailableCostTurns: 1 })))
      .toBe("1.2k tokens across 1 turn in 1 session today. 1 turn reported no cost, so Domovoi has no cost to show.")
    expect(usageTodayDetail(window({ reportedCostTurns: 2, unavailableCostTurns: 1 })))
      .toBe("1.2k tokens across 3 turns in 2 sessions today. 1 turn reported no cost, so this total is partial.")
    expect(usageTodayDetail(window({ turns: 0, sessions: 0, totalTokens: 0, costMicros: 0, reportedCostTurns: 0 }))).toBeUndefined()
  })
})
