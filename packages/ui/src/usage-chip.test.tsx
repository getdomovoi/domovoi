import type { SessionHistoryPage, SessionTurn, SessionUsage, UsageWindow } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { latestTurnFromHistory, unreportedCostNote, usageChipRows, usageChipText, usageChipTriggerText } from "./usage-chip"

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

// The v2 chip has three states of one shape: tokens, separator, then a price
// or a ring. Until the wire says whether a session runs on a subscription or
// an API key (ask 5), every session is the unreported state: tokens alone,
// separator hidden, no money. A provider reports a dollar figure for a
// subscription turn too, and that is money nobody is charged; drawing it was
// the first-hour finding of 2026-09-18. The price and the ring wait on the wire.
describe("usage chip", () => {
  it("names the session's tokens alone while the connection kind is unreported", () => {
    expect(usageChipText(usage)).toBe("42.1k")
    expect(usageChipText({ ...usage, reportedCostTurns: 0, unavailableCostTurns: 9 })).toBe("42.1k")
  })

  it("draws the turn, the session, the context with its share, today, and the window it cannot see", () => {
    const rows = usageChipRows({ usage, turn, today })
    expect(rows.map((row) => row.label)).toEqual(["This turn", "This session", "Context", "Today", "Provider window"])
    expect(rows[4]).toMatchObject({ value: "not reported", note: "This provider has not said what the limit is, so Domovoi draws no dial rather than guessing one." })
    expect(rows[0]).toMatchObject({ value: "8,410 in · 1,206 out", note: "claude-sonnet-4.6 · 3 tool results" })
    expect(rows[1]).toMatchObject({ value: "42.1k tokens", note: "Cost not shown: the wire does not say yet whether these turns ran on a subscription or an API key." })
    expect(rows[2]).toMatchObject({ value: "42.1k of 200k", share: 21 })
    expect(rows[2]?.note).toMatch(/restart the provider thread/)
    expect(rows[3]).toMatchObject({ value: "120k tokens", note: "27 turns in 3 sessions · Domovoi's count, not the provider's limit · Cost not shown: the wire does not say yet whether these turns ran on a subscription or an API key." })
  })

  it("leaves out what it cannot know instead of guessing", () => {
    const rows = usageChipRows({ usage: { ...usage, contextTokens: undefined, contextWindowTokens: undefined }, turn: undefined, today: null })
    expect(rows.map((row) => row.label)).toEqual(["This session", "Provider window"])
    // Partly priced and unpriced sessions read the same: no figure is drawn
    // from either until the connection kind says a figure would be real.
    const partial = usageChipRows({ usage: { ...usage, reportedCostTurns: 5, unavailableCostTurns: 4 }, turn: undefined, today: null })
    expect(partial[0]).toMatchObject({ value: "42.1k tokens", note: unreportedCostNote })
    const unpriced = usageChipRows({ usage: { ...usage, reportedCostTurns: 0, unavailableCostTurns: 9 }, turn: undefined, today: null })
    expect(unpriced[0]).toMatchObject({ value: "42.1k tokens", note: unreportedCostNote })
  })

  it("shows today's tokens alone when no turn was priced", () => {
    const rows = usageChipRows({ usage: null, turn: undefined, today: { ...today, currency: undefined, reportedCostTurns: 0, unavailableCostTurns: 27 } })
    expect(rows[0]).toMatchObject({ label: "Today", value: "120k tokens" })
  })

  it("keeps today's row to tokens and the reason, even when the provider priced part of it", () => {
    const rows = usageChipRows({ usage, turn: undefined, today: { ...today, reportedCostTurns: 1, unavailableCostTurns: 26 } })
    expect(rows.at(-2)).toMatchObject({
      label: "Today",
      value: "120k tokens",
      note: "27 turns in 3 sessions · Domovoi's count, not the provider's limit · Cost not shown: the wire does not say yet whether these turns ran on a subscription or an API key.",
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

  // A fresh session on a busy day: nothing to say for the session, so the
  // chip stands on today's count alone and draws no session rows as zeros.
  it("stands on today's count when the session has no recorded usage", () => {
    const empty: SessionUsage = { ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0, reportedCostTurns: 0, byRuntime: [] }
    expect(usageChipTriggerText(empty, today)).toBe("120k today")
    expect(usageChipTriggerText(null, today)).toBe("120k today")
    expect(usageChipTriggerText(null, { ...today, turns: 0 })).toBeUndefined()
    expect(usageChipRows({ usage: empty, turn, today }).map((row) => row.label)).toEqual(["Today"])
    expect(usageChipTriggerText(usage, today)).toBe("42.1k")
  })
})
