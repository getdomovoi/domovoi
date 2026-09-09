import type { SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function historyPage(sessionId: string): SessionHistoryPage {
  return {
    sessionId,
    hasMore: false,
    items: [{
      id: "thread:checkpoint-7f23",
      sourceId: "checkpoint-7f23",
      sessionId,
      createdAt: "2026-09-08T12:51:00.000Z",
      category: "checkpoints",
      label: "7f23 · before migration",
      commit: "a".repeat(40),
    }],
  }
}

// One restore is one restore. The dock cannot see the thread's local pending
// state, so without a shell-owned guard a second confirmation dispatches a
// second checkpoint.restore while the first is still unanswered.
it("dispatches one checkpoint.restore even when the pane is confirmed twice", async () => {
  const user = userEvent.setup()
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => {
    completeHandshake(socket, snapshot)
  })
  await settle()

  await user.click(screen.getByRole("tab", { name: /History/ }))
  await settle()
  await act(async () => {
    respond(socket, "session.history", historyPage(snapshot.activeSessionId!))
  })
  await settle()

  const history = screen.getByRole("tabpanel", { name: /History/ })
  await user.click(within(history).getByRole("button", { name: "Restore worktree" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restore worktree" }))
  await settle()

  expect(sentRequests(socket, "checkpoint.restore")).toHaveLength(1)
  expect(sentRequests(socket, "checkpoint.restore")[0]?.params).toMatchObject({ checkpointId: "checkpoint-7f23" })

  const again = within(history).getByRole("button", { name: "Restore worktree" }) as HTMLButtonElement
  expect(again.disabled).toBe(true)
  if (!again.disabled) {
    await user.click(again)
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restore worktree" }))
    await settle()
  }
  expect(sentRequests(socket, "checkpoint.restore")).toHaveLength(1)
})
