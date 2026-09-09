import type { SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
        id: "thread:checkpoint-7f23",
        sourceId: "checkpoint-7f23",
        sessionId: "session-billing",
        createdAt: "2026-09-08T12:51:00.000Z",
        category: "checkpoints",
        label: "7f23 · before migration",
        commit: "a".repeat(40),
      },
      {
        id: "thread:checkpoint-7f00",
        sourceId: "checkpoint-7f00",
        sessionId: "session-billing",
        createdAt: "2026-09-08T12:30:00.000Z",
        category: "checkpoints",
        label: "7f00 · text only",
      },
    ],
  }
}

async function panel(overrides: { restoreBlocked?: boolean } = {}) {
  const onRestoreCheckpoint = vi.fn()
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => page())}
      onRestoreCheckpoint={onRestoreCheckpoint}
      restoreBlocked={overrides.restoreBlocked ?? false}
    />,
  )
  await settle()
  return onRestoreCheckpoint
}

// Restore lived only in the thread stream. Scrolling a long thread to reach the
// checkpoint you can see listed in the pane is not a way to recover work.
it("offers restore from the history pane for a checkpoint that has a commit", async () => {
  const user = userEvent.setup()
  const onRestoreCheckpoint = await panel()

  const restore = screen.getAllByRole("button", { name: "Restore worktree" })
  expect(restore).toHaveLength(1)

  await user.click(restore[0]!)
  await user.click(screen.getByRole("button", { name: "Restore worktree", hidden: false }))
  // The daemon builds history ids as thread:<checkpoint-id> and keeps the real
  // checkpoint id in sourceId. checkpoint.restore searches by the latter, so
  // sending the history id is rejected for every checkpoint the daemon made.
  expect(onRestoreCheckpoint).toHaveBeenCalledWith("checkpoint-7f23")
})

it("says nothing about restoring a checkpoint that carries no commit", async () => {
  await panel()
  expect(screen.getByText(/text only/)).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "Restore worktree" })).toHaveLength(1)
})

it("blocks restore from the pane on the same rule as the thread", async () => {
  const onRestoreCheckpoint = await panel({ restoreBlocked: true })
  expect(screen.getByRole("button", { name: "Restore worktree" }).hasAttribute("disabled")).toBe(true)
  expect(onRestoreCheckpoint).not.toHaveBeenCalled()
})
