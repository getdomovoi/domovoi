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

// Walk finding F26, Codex review round 1: a message paged back from history
// still names what it carried, in the chips the thread draws.
it("names the attachments a message carried on its history row", async () => {
  const photo: SessionHistoryEntry = {
    id: "thread:user-photo",
    sourceId: "user-photo",
    sessionId: "session-billing",
    createdAt: "2026-09-08T14:32:00.000Z",
    category: "messages",
    role: "user",
    body: "Describe this image",
    attachments: [{ kind: "image", mimeType: "image/png", width: 640, height: 480, bytes: 52_000 }],
  }
  await panel([photo, message("user-plain", "Ship it")])

  const list = within(row("Describe this image")).getByRole("list", { name: "Sent with this message" })
  expect(within(list).getByRole("listitem").getAttribute("aria-label")).toBe("PNG image, 52.0 kB, 640 by 480 pixels")
  expect(within(row("Ship it")).queryByRole("list", { name: "Sent with this message" })).toBeNull()
})
