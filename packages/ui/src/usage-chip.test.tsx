import type { SessionHistoryPage, SessionTurn, SessionUsage, UsageWindow } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { latestTurnFromHistory, readUsage, unreportedCostNote, usageChipLabel, usageChipRing, usageChipRows, usageChipText, usageChipTriggerText, usageRingCircumference } from "./usage-chip"

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

  it("names the context the turn runs in, not the tokens the session has spent", () => {
    const spent: SessionUsage = { ...usage, totalTokens: 3_700_000, contextTokens: 225_000, contextWindowTokens: 258_000 }
    expect(usageChipText(spent)).toBe("225k")
  })

  // The context and the session's running total are different quantities. A
  // fallback says which one it is, so the chip never reads 62.1k after one
  // turn and 332k during the next as if both were the same number.
  it("labels the session's tokens when the provider reports no context", () => {
    const { contextTokens: _tokens, contextWindowTokens: _window, ...noContext } = usage
    expect(usageChipText(noContext)).toBe("42.1k session")
    expect(usageChipTriggerText(noContext, today)).toBe("42.1k session")
  })

  it("names what the chip's number counts for assistive technology", () => {
    const { contextTokens: _tokens, contextWindowTokens: _window, ...noContext } = usage
    expect(usageChipLabel(usage, today)).toBe("Usage: 42.1k of 200k tokens in context")
    expect(usageChipLabel(noContext, today)).toBe("Usage: 42.1k tokens this session, no context reported")
    expect(usageChipLabel(null, today)).toBe("Usage: 120k tokens today")
  })

  it("draws the turn, the session, the context with its share, today, and the window it cannot see", () => {
    const rows = usageChipRows({ usage, turn, today })
    expect(rows.map((row) => row.label)).toEqual(["This turn", "This session", "Context", "Today", "Provider window"])
    expect(rows[4]).toMatchObject({ value: "not reported", note: "This provider has not said what the limit is, so Domovoi draws no dial rather than guessing one." })
    expect(rows[0]).toMatchObject({ value: "8,410 in · 1,206 out", note: "claude-sonnet-4.6 · 3 tool results" })
    expect(rows[1]).toMatchObject({ value: "42.1k tokens", note: `Input and output of every model request, cached input included: the same count as This turn and Today. ${unreportedCostNote}` })
    expect(rows[2]).toMatchObject({ value: "42.1k of 200k", share: 21 })
    expect(rows[2]?.note).toBe("What the conversation holds at the provider's last report, not a running total. The provider compacts near the window's edge, or restart the provider thread for a fresh one.")
    expect(rows[3]).toMatchObject({ value: "120k tokens", note: `27 turns started on this machine today, in 3 sessions · Domovoi's count, not the provider's limit · ${unreportedCostNote}` })
  })

  // "in" and "out" add up to the turn's total, the number the session sums:
  // reasoning is output, and cached input is input.
  it("counts the turn the way the session counts it", () => {
    const reasoned: SessionTurn = { ...turn, usage: { ...turn.usage, inputTokens: 202_594, cachedInputTokens: 180_112, outputTokens: 186, reasoningTokens: 40, totalTokens: 202_820 } }
    expect(usageChipRows({ usage, turn: reasoned, today: null })[0]).toMatchObject({
      value: "202,594 in · 226 out",
      note: "180,112 of the input was cached · claude-sonnet-4.6 · 3 tool results",
    })
  })

  it("says a running turn is counted so far, and never shows an unreported turn as zero", () => {
    const { completedAt: _completedAt, ...started } = turn
    const running: SessionTurn = { ...started, status: "pending", coverage: "pending" }
    expect(usageChipRows({ usage, turn: running, today: null })[0]).toMatchObject({
      value: "8,410 in · 1,206 out",
      note: "Running, counted so far · claude-sonnet-4.6 · 3 tool results",
    })
    const empty = { ...turn.usage, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
    expect(usageChipRows({ usage, turn: { ...running, usage: empty }, today: null })[0]).toMatchObject({
      value: "none reported yet",
      note: "Running, counted so far · claude-sonnet-4.6 · 3 tool results",
    })
    expect(usageChipRows({ usage, turn: { ...turn, coverage: "unavailable", usage: empty }, today: null })[0]).toMatchObject({
      value: "not reported",
      note: "The provider reported no usage for this turn · claude-sonnet-4.6 · 3 tool results",
    })
    expect(usageChipRows({ usage, turn: { ...turn, coverage: "partial" }, today: null })[0]).toMatchObject({
      note: "Partly reported · claude-sonnet-4.6 · 3 tool results",
    })
  })

  it("says the session's tokens are not reported rather than drawing zero", () => {
    const silent: SessionUsage = {
      ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
      coverage: { pending: 0, complete: 0, partial: 0, unavailable: 4, legacy: 0 },
      byRuntime: [{ provider: "gemini", model: "gemini-3", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0, turns: 4 }],
    }
    expect(usageChipRows({ usage: silent, turn: undefined, today: null })[0]).toMatchObject({ label: "This session", value: "not reported" })
    const { contextTokens: _tokens, contextWindowTokens: _window, ...silentNoContext } = silent
    expect(usageChipTriggerText(silentNoContext, null)).toBe("not reported")
    expect(usageChipLabel(silentNoContext, null)).toBe("Usage: tokens not reported for this session")
    const silentToday: UsageWindow = { ...today, inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 4, sessions: 1,
      coverage: { pending: 0, complete: 0, partial: 0, unavailable: 4, legacy: 0 } }
    expect(usageChipRows({ usage: null, turn: undefined, today: silentToday })[0]).toMatchObject({ label: "Today", value: "not reported" })
    expect(usageChipTriggerText(null, silentToday)).toBe("not reported today")
    expect(usageChipLabel(null, silentToday)).toBe("Usage: tokens not reported today")

    // A first turn still running has reported nothing yet; that is not zero either.
    const starting: SessionUsage = { ...silentNoContext, coverage: { pending: 1, complete: 0, partial: 0, unavailable: 0, legacy: 0 } }
    expect(usageChipTriggerText(starting, null)).toBe("not reported yet")
    expect(usageChipLabel(starting, null)).toBe("Usage: tokens not reported yet for this session")
    expect(usageChipRows({ usage: starting, turn: undefined, today: { ...silentToday, coverage: starting.coverage } }).map((row) => [row.label, row.value]))
      .toEqual([["This session", "not reported yet"], ["Today", "not reported yet"], ["Provider window", "not reported"]])
  })

  it("says a count may be low when turns were reported in part or not at all", () => {
    const partly: SessionUsage = { ...usage, coverage: { pending: 0, complete: 7, partial: 1, unavailable: 1, legacy: 0 } }
    expect(usageChipRows({ usage: partly, turn: undefined, today: null })[0]?.note).toBe(
      `Input and output of every model request, cached input included: the same count as This turn and Today. 2 turns were reported in part or not at all, so the count may be low. ${unreportedCostNote}`,
    )
    const day: UsageWindow = { ...today, coverage: { pending: 0, complete: 26, partial: 1, unavailable: 0, legacy: 0 } }
    expect(usageChipRows({ usage: null, turn: undefined, today: day })[0]?.note).toBe(
      `27 turns started on this machine today, in 3 sessions · 1 turn was reported in part or not at all, so the count may be low · Domovoi's count, not the provider's limit · ${unreportedCostNote}`,
    )
  })

  // A running turn's requests are absent from the total or counted so far,
  // so a total that includes one is not yet every model request.
  it("says a count may be low while a turn is still running", () => {
    const running: SessionUsage = { ...usage, coverage: { pending: 1, complete: 8, partial: 0, unavailable: 0, legacy: 0 } }
    expect(usageChipRows({ usage: running, turn: undefined, today: null })[0]?.note).toBe(
      `Input and output of every model request, cached input included: the same count as This turn and Today. 1 turn is still running, so the count may be low. ${unreportedCostNote}`,
    )
    const day: UsageWindow = { ...today, coverage: { pending: 2, complete: 24, partial: 1, unavailable: 0, legacy: 0 } }
    expect(usageChipRows({ usage: null, turn: undefined, today: day })[0]?.note).toBe(
      `27 turns started on this machine today, in 3 sessions · 2 turns are still running and 1 turn was reported in part or not at all, so the count may be low · Domovoi's count, not the provider's limit · ${unreportedCostNote}`,
    )
  })

  // A legacy row predates the ledger's evidence and may hold an older count
  // (a Codex turn's last request alone, a Claude turn's main loop alone).
  it("counts legacy turns among those that may be low", () => {
    const old: SessionUsage = { ...usage, coverage: { pending: 0, complete: 5, partial: 0, unavailable: 0, legacy: 3 } }
    expect(usageChipRows({ usage: old, turn: undefined, today: null })[0]?.note).toBe(
      `Input and output of every model request, cached input included: the same count as This turn and Today. 3 turns were reported in part or not at all, so the count may be low. ${unreportedCostNote}`,
    )
    const day: UsageWindow = { ...today, coverage: { pending: 0, complete: 26, partial: 0, unavailable: 0, legacy: 1 } }
    expect(usageChipRows({ usage: null, turn: undefined, today: day })[0]?.note).toContain("1 turn was reported in part or not at all, so the count may be low")
  })

  // The usage contract lets totalTokens exceed its parts (a provider that
  // reports only a total). The turn row then shows the total the session sums.
  it("shows a turn's total when the provider broke down only part of it", () => {
    const aggregate: SessionTurn = { ...turn, usage: { ...turn.usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 120 } }
    expect(usageChipRows({ usage, turn: aggregate, today: null })[0]).toMatchObject({
      value: "120 tokens",
      note: "0 in and 0 out were broken down; the provider reported the rest only as a total · claude-sonnet-4.6 · 3 tool results",
    })
  })

  // Usage only grows, so totals read after the turn cannot fall below it. Read
  // the other way round, a live turn sat next to totals from when it started.
  it("reads the turn before the totals", async () => {
    const order: string[] = []
    let releaseTurn: (value: SessionTurn | undefined) => void = () => {}
    const reading = readUsage({
      turn: () => { order.push("turn"); return new Promise((resolve) => { releaseTurn = resolve }) },
      session: async () => { order.push("session"); return usage },
      today: async () => { order.push("today"); return today },
    })
    await Promise.resolve()
    expect(order).toEqual(["turn"])
    releaseTurn(turn)
    expect(await reading).toEqual({ turn, usage, today })
    expect(order).toEqual(["turn", "session", "today"])
  })

  it("keeps the session reading when today cannot be read", async () => {
    expect(await readUsage({
      turn: async () => turn,
      session: async () => usage,
      today: async () => { throw new Error("offline") },
    })).toEqual({ turn, usage, today: null })
  })

  it("shows provider-reported 5-hour and weekly quota windows", () => {
    const rows = usageChipRows({
      usage: {
        ...usage,
        providerLimits: {
          provider: "codex",
          planType: "plus",
          windows: [
            { kind: "primary", usedPercent: 23, windowDurationMinutes: 300, resetsAt: "2026-09-20T22:00:00.000Z" },
            { kind: "secondary", usedPercent: 41, windowDurationMinutes: 10_080, resetsAt: "2026-09-24T22:00:00.000Z" },
          ],
        },
      },
      turn: undefined,
      today: null,
    })

    expect(rows.map((row) => row.label)).toEqual(["This session", "Context", "5-hour limit", "Weekly limit"])
    expect(rows[2]).toMatchObject({ value: "23% used", share: 23 })
    expect(rows[2]?.note).toContain("Resets")
    expect(rows[3]).toMatchObject({ value: "41% used", share: 41 })
    expect(rows[3]?.note).toContain("Resets")
  })

  // The signed v2 chip draws a ring for the tighter of the provider's two
  // windows. Two windows run at once, so the number a person needs is the one
  // that will stop them first, and the label names which window that is.
  it("draws the ring for the tighter provider window", () => {
    const ring = usageChipRing({
      ...usage,
      providerLimits: {
        provider: "codex",
        windows: [
          { kind: "primary", usedPercent: 68, windowDurationMinutes: 300, resetsAt: "2026-09-20T17:40:00.000Z" },
          { kind: "secondary", usedPercent: 82, windowDurationMinutes: 10_080, resetsAt: "2026-09-24T09:00:00.000Z" },
        ],
      },
    })

    expect(ring?.percent).toBe(82)
    expect(ring?.warning).toBe(false)
    expect(ring?.offset).toBeCloseTo(usageRingCircumference * (1 - 82 / 100), 2)
    expect(ring?.label).toContain("82 percent of the weekly window")
    expect(ring?.label).toContain("which is the tighter of the two")
  })

  it("turns the ring to the warning colour once a window is nearly spent", () => {
    const ring = usageChipRing({
      ...usage,
      providerLimits: {
        provider: "codex",
        windows: [{ kind: "primary", usedPercent: 85, windowDurationMinutes: 300 }],
      },
    })

    expect(ring?.warning).toBe(true)
    expect(ring?.label).toContain("85 percent of the 5 hour window")
    expect(ring?.label).not.toContain("tighter")
  })

  it("draws no ring while no provider window is reported", () => {
    expect(usageChipRing(usage)).toBeUndefined()
    expect(usageChipRing(null)).toBeUndefined()
  })

  it("leaves out what it cannot know instead of guessing", () => {
    const rows = usageChipRows({ usage: { ...usage, contextTokens: undefined, contextWindowTokens: undefined }, turn: undefined, today: null })
    expect(rows.map((row) => row.label)).toEqual(["This session", "Provider window"])
    // Partly priced and unpriced sessions read the same: no figure is drawn
    // from either until the connection kind says a figure would be real.
    const partial = usageChipRows({ usage: { ...usage, reportedCostTurns: 5, unavailableCostTurns: 4 }, turn: undefined, today: null })
    const sessionNote = `Input and output of every model request, cached input included: the same count as This turn and Today. ${unreportedCostNote}`
    expect(partial[0]).toMatchObject({ value: "42.1k tokens", note: sessionNote })
    const unpriced = usageChipRows({ usage: { ...usage, reportedCostTurns: 0, unavailableCostTurns: 9 }, turn: undefined, today: null })
    expect(unpriced[0]).toMatchObject({ value: "42.1k tokens", note: sessionNote })
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
      note: "27 turns started on this machine today, in 3 sessions · Domovoi's count, not the provider's limit · Cost not shown: Domovoi cannot yet tell whether these turns ran on a subscription or an API key.",
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
