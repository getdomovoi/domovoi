import type { SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { HistoryPanel } from "./workspace-shell"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function page(): SessionHistoryPage {
  return {
    sessionId: "session-billing",
    hasMore: false,
    items: [
      {
        id: "thread:tool-1",
        sourceId: "tool-1",
        sessionId: "session-billing",
        createdAt: "2026-09-08T14:32:00.000Z",
        category: "tools",
        tool: "command",
        status: "failed",
        title: "pnpm test",
        output: "1 failing",
      },
    ],
  }
}

async function panel() {
  const { container } = render(
    <HistoryPanel sessionId="session-billing" connected onLoad={vi.fn(async () => page())} />,
  )
  await settle()
  return container
}

// The design draws one card with rows inside it, not a bare stack.
it("draws the rows inside a single bordered card", async () => {
  const container = await panel()
  const card = container.querySelector("[data-testid='history-rows']")

  expect(card?.className).toContain("rounded-")
  expect(card?.className).toContain("border")
})

// Dot, then time, then content. The time is a column of its own so the titles
// line up down the list rather than starting wherever the time ended.
it("puts the time in a fixed column before the title", async () => {
  const container = await panel()
  const time = container.querySelector("[data-testid='history-time']")

  expect(time?.textContent).toBe("14:32")
  expect(time?.className).toContain("w-[42px]")
  expect(time?.className).toContain("font-machine")

  const title = screen.getByText("pnpm test")
  expect(time!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

// The dot says the outcome, and says it in a word for anyone who cannot see
// that it is red.
it("names the outcome beside the dot without drawing the word", async () => {
  await panel()
  const outcome = screen.getByText("failed")

  expect(outcome.className).toContain("sr-only")
})

// The badge is the row's category and belongs on the title line, not stacked
// under it where it reads as content.
it("keeps the category badge on the title line", async () => {
  await panel()
  const badge = screen.getByText("tools")
  const title = screen.getByText("pnpm test")

  expect(badge.parentElement).toBe(title.parentElement)
})

// Forty rows of raw output inside a history row is the row losing its argument.
it("keeps the output out of the row and reachable underneath it", async () => {
  const container = await panel()

  expect(container.querySelector("[data-testid='history-meta']")?.textContent)
    .toBe("command · failed")
  const disclosure = container.querySelector("details")
  expect(disclosure?.open).toBe(false)
  expect(disclosure?.querySelector("pre")?.textContent).toBe("1 failing")
})
