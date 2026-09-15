import type { SessionHistoryPage, SessionTurn, SessionUsage, UsageWindow } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { latestTurnFromHistory, usageChipRows, usageChipText } from "./usage-chip"

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

  it("says when today's cost is partial instead of showing it as complete", () => {
    const rows = usageChipRows({ usage, turn: undefined, today: { ...today, reportedCostTurns: 1, unavailableCostTurns: 26 } })
    expect(rows.at(-1)).toMatchObject({
      label: "Today",
      value: "120k tokens · $1.12",
      note: "27 turns in 3 sessions · Domovoi's count, not the provider's limit · 26 turns reported no cost, so this total is partial.",
    })
  })

  it("walks past a system receipt to the newest entry that carries a turn", async () => {
    type Load = Parameters<typeof latestTurnFromHistory>[0]
    const receipt: SessionHistoryPage["items"][number] = { id: "thread:receipt", sourceId: "receipt", sessionId: "session-billing", createdAt: "2026-09-15T14:09:00+00:00", category: "messages" as const, role: "system" as const, body: "Worktree restored" }
    const message: SessionHistoryPage["items"][number] = { id: "thread:assistant-9", sourceId: "assistant-9", sessionId: "session-billing", createdAt: "2026-09-15T14:08:00+00:00", category: "messages" as const, role: "assistant" as const, body: "Done", turnId: "turn-9", turn }
    const calls: unknown[] = []
    const load: Load = async (_sessionId, options) => {
      calls.push(options)
      return options?.before
        ? { sessionId: "session-billing", hasMore: false, items: [message] }
        : { sessionId: "session-billing", hasMore: true, nextCursor: "thread:receipt", items: [receipt] }
    }
    expect(await latestTurnFromHistory(load, "session-billing")).toEqual(turn)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ before: "thread:receipt" })

    let pages = 0
    const endless: Load = async () => { pages += 1; return { sessionId: "session-billing", hasMore: true, nextCursor: `thread:${pages}`, items: [receipt] } }
    expect(await latestTurnFromHistory(endless, "session-billing")).toBeUndefined()
    expect(pages).toBe(3)
  })
})
