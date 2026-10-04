import type { SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { HistoryPanel } from "./workspace-shell"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function message(id: string, body: string, overLimit?: number): SessionHistoryEntry {
  return {
    id: `thread:${id}`,
    sourceId: id,
    sessionId: "session-billing",
    createdAt: "2026-09-08T14:32:00.000Z",
    category: "messages",
    role: "user",
    body,
    ...(overLimit === undefined ? {} : { annotationsOverLimit: overLimit }),
  }
}

async function panel(items: SessionHistoryEntry[]) {
  const page: SessionHistoryPage = { sessionId: "session-billing", hasMore: false, items }
  render(<HistoryPanel sessionId="session-billing" connected onLoad={vi.fn(async () => page)} />)
  await settle()
}

function row(title: string): HTMLElement {
  return screen.getAllByTestId("history-row").find((candidate) => within(candidate).queryAllByText(title).length > 0)!
}

// The thread notes beside a sent message how many open annotations the
// per-turn limit left out. History draws the same sentence on that message's
// row (Q431), and a message recorded without the count draws nothing new.
it("draws the over-limit sentence beside the message that left annotations out", async () => {
  await panel([
    message("user-one", "Fix the webhook", 1),
    message("user-many", "Retry the import", 3),
    message("user-legacy", "Ship it"),
  ])

  expect(within(row("Fix the webhook")).getByText("1 open annotation was over the per-turn limit")).toBeTruthy()
  expect(within(row("Retry the import")).getByText("3 open annotations were over the per-turn limit")).toBeTruthy()
  expect(within(row("Ship it")).queryByText(/over the per-turn limit/u)).toBeNull()
})
