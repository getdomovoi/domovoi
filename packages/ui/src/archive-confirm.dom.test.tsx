import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  pendingRequest,
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

// Archive runs from the sessions drawer's row menu, so its confirmation is the
// one a person reads. Open it for a session that is not the active one.
async function openArchiveConfirmation(session: { workspacePath?: string, branch?: string }) {
  const user = userEvent.setup()
  const base = workspaceSnapshot()
  const target = base.sessions.find((entry) => entry.id !== base.activeSessionId && !entry.activeTurnId)!
  const { workspacePath: _path, branch: _branch, ...rest } = target
  const snapshot = workspaceSnapshot({
    sessions: base.sessions.map((entry) => entry.id === target.id ? { ...rest, ...session } : entry),
  })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
  await user.click(screen.getByRole("button", { name: `Actions for ${target.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Archive session" }))
  return { user, socket, target, dialog: screen.getByRole("alertdialog") }
}

// I69: the confirmation says exactly what archive does. Removed and kept are
// listed, the loss is named, and the actions say what they do.
it("lists what archive removes and keeps, and cannot be undone", async () => {
  const { user, socket, target, dialog } = await openArchiveConfirmation({
    workspacePath: "/Users/dana/src/acme-api/.domovoi/wt-billing-idem",
    branch: "wt-billing-idem",
  })
  expect(within(dialog).getByText(`Archive ${target.title}?`)).toBeTruthy()
  expect(dialog.textContent).toContain("Domovoi takes a final checkpoint, stops the agent and its terminals, then removes the worktree directory. Nothing is merged.")
  const removed = within(dialog).getByRole("list", { name: "REMOVED" })
  expect(removed.textContent).toContain("The worktree directory")
  expect(removed.textContent).toContain("/Users/dana/src/acme-api/.domovoi/wt-billing-idem")
  expect(removed.textContent).toContain("The agent and its terminals, stopped")
  const kept = within(dialog).getByRole("list", { name: "KEPT" })
  const branchItem = within(kept).getAllByRole("listitem")[0]!
  expect(branchItem.textContent).toBe("The branch wt-billing-idem, as it is")
  expect(within(branchItem).getByText("wt-billing-idem").className).toContain("font-machine")
  expect(kept.textContent).not.toContain("never merged")
  expect(kept.textContent).toContain("The final checkpoint, taken on that branch")
  expect(kept.textContent).toContain("The thread, readable here")
  expect(dialog.textContent).toContain("This cannot be undone. An archived session cannot be forked, unarchived or sent to.")
  await user.click(within(dialog).getByRole("button", { name: "Keep the session" }))
  expect(sentRequests(socket, "session.archive")).toHaveLength(0)
  await user.click(screen.getByRole("button", { name: `Actions for ${target.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Archive session" }))
  await user.click(screen.getByRole("button", { name: "Archive and remove the worktree" }))
  expect(pendingRequest(socket, "session.archive").params).toMatchObject({ sessionId: target.id })
})

// Ruled 2026-09-23: the daemon counts unmerged files only while archiving, so
// the confirmation cannot know the count and must not imply files exist.
it("names the session branch as it is when the branch is not known", async () => {
  const { dialog } = await openArchiveConfirmation({})
  const kept = within(dialog).getByRole("list", { name: "KEPT" })
  expect(within(kept).getAllByRole("listitem")[0]!.textContent).toBe("The session branch, as it is")
})
