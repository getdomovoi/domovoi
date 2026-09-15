import type { SessionTurn, SessionUsage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { UsageChip } from "./usage-chip"

afterEach(cleanup)

const usage: SessionUsage = {
  sessionId: "session-billing",
  inputTokens: 34_000, cachedInputTokens: 0, outputTokens: 8_118, reasoningTokens: 0, totalTokens: 42_118,
  costMicros: 380_000, currency: "USD", reportedCostTurns: 9, unavailableCostTurns: 0,
  byRuntime: [],
}

function turn(ordinal: number, inputTokens: number): SessionTurn {
  return {
    id: `turn-${ordinal}`, sessionId: "session-billing", ordinal,
    startedAt: "2026-09-15T14:07:00+00:00", completedAt: "2026-09-15T14:08:00+00:00",
    provider: "claude", requestedModel: "claude-sonnet-4.6", reportedModels: ["claude-sonnet-4.6"],
    status: "completed", coverage: "complete", recordedToolCount: 0,
    usage: { costSource: "provider-reported", inputTokens, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: inputTokens + 1, costMicros: 1, currency: "USD" },
  }
}

type Deferred = { resolve: (value: SessionTurn | undefined) => void, signal: AbortSignal }

// Open, close, open again: the first read is aborted, and even if it settles
// after the second one, it cannot overwrite the second read's turn.
it("aborts a superseded read and keeps the newest open's turn", async () => {
  const reads: Deferred[] = []
  const loadLatestTurn = vi.fn((signal: AbortSignal) => new Promise<SessionTurn | undefined>((resolve) => { reads.push({ resolve, signal }) }))
  render(<UsageChip usage={usage} today={null} loadLatestTurn={loadLatestTurn} />)
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "Usage" }))
  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("button", { name: "Usage" }))
  expect(reads).toHaveLength(2)
  expect(reads[0]!.signal.aborted).toBe(true)
  expect(reads[1]!.signal.aborted).toBe(false)

  await act(async () => { reads[1]!.resolve(turn(2, 2_000)) })
  expect(screen.getByText("2,000 in · 1 out")).toBeTruthy()
  await act(async () => { reads[0]!.resolve(turn(1, 1_000)) })
  expect(screen.getByText("2,000 in · 1 out")).toBeTruthy()
  expect(screen.queryByText("1,000 in · 1 out")).toBeNull()
})
