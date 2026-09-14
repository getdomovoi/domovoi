import type { SessionHistoryEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { sessionHistoryEntryDetail } from "./session-history"

const base = {
  id: "thread:one",
  sourceId: "one",
  sessionId: "session-billing",
  createdAt: "2026-09-10T14:08:00.000Z",
}

const usage = (totalTokens: number) => ({
  costSource: "unavailable" as const,
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens,
})

const turn = (over: Record<string, unknown> = {}) => ({
  id: "turn-1",
  sessionId: "session-billing",
  ordinal: 9,
  startedAt: "2026-09-10T14:08:00.000Z",
  completedAt: "2026-09-10T14:09:00.000Z",
  provider: "claude",
  requestedModel: "sonnet-4.6",
  reportedModels: ["sonnet-4.6"],
  status: "completed",
  coverage: "complete",
  usage: usage(12_400),
  recordedToolCount: 3,
  ...over,
})

const message = (over: Record<string, unknown> = {}) => ({
  ...base,
  category: "messages",
  role: "user",
  body: "Rewrote replay.spec.ts",
  ...over,
} as unknown as SessionHistoryEntry)

// CX2 gave a history row a durable link to its turn, so the row can finally
// name the turn instead of counting rows and hoping. The numbers are only worth
// drawing if the row also says when they are not final.
describe("turn meta on a history row", () => {
  it("draws the four fields the design asks for", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn() })))
      .toBe("turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens")
  })

  it("counts one tool without pluralising it", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn({ recordedToolCount: 1 }) })))
      .toBe("turn 9 · sonnet-4.6 · 1 tool · 12.4k tokens")
  })

  it("keeps small token counts exact rather than rounding them to nothing", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn({ usage: usage(842) }) })))
      .toBe("turn 9 · sonnet-4.6 · 3 tools · 842 tokens")
  })

  it("scales past a million, rounding rather than truncating", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn({ usage: usage(2_450_000) }) })))
      .toBe("turn 9 · sonnet-4.6 · 3 tools · 2.5M tokens")
  })

  // A number that looks auditable and is not is worse than no number. Coverage
  // is the daemon saying how much of this turn it actually saw, and the row
  // repeats that rather than presenting a floor as a total.
  it("marks a partial turn instead of presenting its floor as a total", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn({ coverage: "partial" }) })))
      .toBe("turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens · partial")
  })

  it("says a running turn is running rather than drawing a total for it", () => {
    expect(sessionHistoryEntryDetail(message({
      turn: turn({ status: "pending", coverage: "pending", completedAt: undefined }),
    }))).toBe("turn 9 · sonnet-4.6 · running")
  })

  it("says usage is unavailable rather than drawing zero", () => {
    expect(sessionHistoryEntryDetail(message({ turn: turn({ coverage: "unavailable", usage: usage(0) }) })))
      .toBe("turn 9 · sonnet-4.6 · usage unavailable")
  })

  // A row recorded before CX2 has no turn, and absent is its own answer: it
  // falls back to what the row said before rather than claiming turn 0.
  it("leaves a row with no turn exactly as it was", () => {
    expect(sessionHistoryEntryDetail(message())).toBe("user")
  })
})

// CX5 gave a checkpoint a typed reason. The session-start row is the one place
// the design draws no fork, and its meta says why.
describe("the session-start checkpoint", () => {
  const checkpoint = (over: Record<string, unknown> = {}) => ({
    ...base,
    category: "checkpoints",
    label: "8f3c1de · session start",
    commit: "8f3c1de5a9b7c3d1e0f2a4b6c8d0e2f4a6b8c0d2",
    ...over,
  } as unknown as SessionHistoryEntry)

  it("says what it is and why there is nothing behind it", () => {
    expect(sessionHistoryEntryDetail(checkpoint({ reason: "session-start" }), { worktreeName: "wt-billing" }))
      .toBe("session start · nothing to revert past this")
  })

  it("leaves every other checkpoint reading as it did", () => {
    expect(sessionHistoryEntryDetail(checkpoint({ reason: "manual" }), { worktreeName: "wt-billing" }))
      .toBe("commit 8f3c1de5 · worktree wt-billing")
  })

  it("does not treat a legacy checkpoint with no reason as a session start", () => {
    expect(sessionHistoryEntryDetail(checkpoint(), { worktreeName: "wt-billing" }))
      .toBe("commit 8f3c1de5 · worktree wt-billing")
  })
})
