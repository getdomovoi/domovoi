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
