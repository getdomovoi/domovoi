import type { SessionTurn, SessionUsage, UsageWindow } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { usageChipRows, usageChipText } from "./usage-chip"

const usage: SessionUsage = {
  sessionId: "session-billing",
  inputTokens: 34_000, cachedInputTokens: 0, outputTokens: 8_118, reasoningTokens: 0, totalTokens: 42_118,
  costMicros: 380_000, currency: "USD", reportedCostTurns: 9, unavailableCostTurns: 0,
  contextTokens: 42_118, contextWindowTokens: 200_000,
  byRuntime: [],
}
const turn: SessionTurn = {
  id: "turn-9", sessionId: "session-billing", ordinal: 9,
  startedAt: "2026-09-15T14:07:00+00:00", completedAt: "2026-09-15T14:08:00+00:00",
  provider: "claude", requestedModel: "claude-sonnet-4.6", reportedModels: ["claude-sonnet-4.6"],
  status: "completed", coverage: "complete", recordedToolCount: 3,
  usage: { costSource: "provider-reported", inputTokens: 8_410, cachedInputTokens: 0, outputTokens: 1_206, reasoningTokens: 0, totalTokens: 9_616, costMicros: 90_000, currency: "USD" },
}
const today: UsageWindow = {
  inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 20_000, reasoningTokens: 0, totalTokens: 120_000,
  costMicros: 1_120_000, currency: "USD", sessions: 3, turns: 27, reportedCostTurns: 27, unavailableCostTurns: 0,
}

// The v2 chip reads "42.1k · $0.38" and opens four rows. The fourth row in the
// design is the provider's own window, which no daemon can observe; ours is
// Domovoi's accounting for today and the row says so rather than pretending.
describe("usage chip", () => {
  it("names the session's tokens and cost, or says the cost is unavailable", () => {
    expect(usageChipText(usage)).toBe("42.1k · $0.38")
    expect(usageChipText({ ...usage, reportedCostTurns: 0, unavailableCostTurns: 9 })).toBe("42.1k · cost unavailable")
  })

  it("draws the turn, the session, the context with its share, and today", () => {
    const rows = usageChipRows({ usage, turn, today })
    expect(rows.map((row) => row.label)).toEqual(["This turn", "This session", "Context", "Today"])
    expect(rows[0]).toMatchObject({ value: "8,410 in · 1,206 out", note: "claude-sonnet-4.6 · 3 tool results" })
    expect(rows[1]).toMatchObject({ value: "42.1k tokens · $0.38" })
    expect(rows[2]).toMatchObject({ value: "42.1k of 200k", share: 21 })
    expect(rows[2]?.note).toMatch(/restart the provider thread/)
    expect(rows[3]).toMatchObject({ value: "120k tokens · $1.12", note: "27 turns in 3 sessions · Domovoi's count, not the provider's limit" })
  })

  it("leaves out what it cannot know instead of guessing", () => {
    const rows = usageChipRows({ usage: { ...usage, contextTokens: undefined, contextWindowTokens: undefined }, turn: undefined, today: null })
    expect(rows.map((row) => row.label)).toEqual(["This session"])
    const partial = usageChipRows({ usage: { ...usage, reportedCostTurns: 5, unavailableCostTurns: 4 }, turn: undefined, today: null })
    expect(partial[0]?.note).toBe("4 turns reported no cost, so this total is partial.")
  })
})
