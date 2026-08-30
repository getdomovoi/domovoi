import { describe, expect, it } from "vitest"
import {
  boundedClientThread,
  maximumClientSnapshotThreadItems,
  maximumEffectiveClientThreadItems,
  maximumRenderedPreviewStages,
  maximumRenderedThreadItems,
  maximumSessionHistoryPageItems,
  performanceBudgets,
  performanceLimitsFor,
} from "./performance.js"

describe("boundedClientThread", () => {
  it("keeps an exact hard cap when source entries repeat by reference", () => {
    const inactive = { sessionId: "inactive" }
    const active = { sessionId: "active" }
    const items = [
      ...Array.from({ length: 200 }, () => inactive),
      ...Array.from({ length: 50 }, () => active),
    ]

    const bounded = boundedClientThread(items, "active")

    expect(bounded).toHaveLength(maximumEffectiveClientThreadItems)
    expect(bounded.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => inactive))
    expect(bounded.slice(50)).toEqual(Array.from({ length: 50 }, () => active))
  })

  it("wires independent canonical fields to their production limits", () => {
    const budgets = structuredClone(performanceBudgets)
    budgets.memory.clientSnapshotThreadItems = 120
    budgets.longThreads.historyPageItems = 73
    budgets.longThreads.renderedThreadItems = 80
    budgets.largePreviews.renderedStages = 1

    expect(performanceLimitsFor(budgets)).toMatchObject({
      clientSnapshotThreadItems: 120,
      sessionHistoryPageItems: 73,
      renderedThreadItems: 80,
      effectiveClientThreadItems: 80,
      renderedPreviewStages: 1,
    })
    expect(maximumClientSnapshotThreadItems).toBe(performanceBudgets.memory.clientSnapshotThreadItems)
    expect(maximumSessionHistoryPageItems).toBe(performanceBudgets.longThreads.historyPageItems)
    expect(maximumRenderedThreadItems).toBe(performanceBudgets.longThreads.renderedThreadItems)
    expect(maximumRenderedPreviewStages).toBe(performanceBudgets.largePreviews.renderedStages)
  })
})
