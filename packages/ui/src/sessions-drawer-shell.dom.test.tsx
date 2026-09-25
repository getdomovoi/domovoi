import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  pendingRequest,
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

const composer = /Steer it, or queue the next message|Cannot send, the daemon is not answering/

it("opens the chosen session's thread, whichever surface the drawer was used from", async () => {
  const user = userEvent.setup()
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => {
    completeHandshake(socket, snapshot)
  })
  await settle()
  expect(screen.queryByPlaceholderText(composer)).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  expect(screen.queryByPlaceholderText(composer)).toBeNull()

  await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
  const other = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId)!
  // The row button is named by the title; the row's menu is "Actions for …".
  await user.click(screen.getByRole("button", { name: new RegExp(`^${other.title.slice(0, 24)}`) }))
  await settle()

  // The surface switch alone is not the fix. Without the activation the daemon
  // never hears which session was picked, and the thread on screen stays the
  // one that was already open.
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
  await act(async () => {
    respond(socket, "session.activate", workspaceSnapshot({
      activeSessionId: other.id,
      thread: [{
        id: "activated-thread-note",
        sessionId: other.id,
        kind: "system",
        body: "The audit thread is open",
        createdAt: "2026-09-08T12:00:00.000Z",
      }],
    }))
  })
  await settle()

  expect(screen.getByPlaceholderText(composer)).toBeTruthy()
  expect(screen.getByText("The audit thread is open")).toBeTruthy()
})

// The drawer is a column beside the thread. Its row menu reaches the daemon
// for the session the row names, not the one that happens to be open.
it("stops and archives a session from its row, and forks by opening its checkpoints", async () => {
  const user = userEvent.setup()
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({
    sessions: base.sessions.map((session, index) => index === 0 ? { ...session, state: "active" as const, activeTurnId: "turn-1" } : session),
  })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()

  await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
  expect(screen.getByRole("complementary", { name: "Sessions" })).toBeTruthy()
  const running = snapshot.sessions[0]!
  await user.click(screen.getByRole("button", { name: `Actions for ${running.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Stop the agent" }))
  expect(pendingRequest(socket, "session.pause").params).toMatchObject({ sessionId: running.id })
  await act(async () => { respond(socket, "session.pause", snapshot) })
  await settle()

  const other = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId && !session.activeTurnId)!
  // Archive asks first, with the row's session named, and Cancel sends nothing.
  await user.click(screen.getByRole("button", { name: `Actions for ${other.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Archive session" }))
  expect(screen.getByRole("alertdialog").textContent).toContain(other.title)
  expect(sentRequests(socket, "session.archive")).toHaveLength(0)
  // I69: the confirmation's actions say what they do.
  await user.click(screen.getByRole("button", { name: "Keep the session" }))
  expect(sentRequests(socket, "session.archive")).toHaveLength(0)
  await user.click(screen.getByRole("button", { name: `Actions for ${other.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Archive session" }))
  await user.click(screen.getByRole("button", { name: "Archive and remove the worktree" }))
  expect(pendingRequest(socket, "session.archive").params).toMatchObject({ sessionId: other.id })
  await act(async () => { respond(socket, "session.archive", snapshot) })
  await settle()

  await user.click(screen.getByRole("button", { name: `Actions for ${other.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Fork from a checkpoint" }))
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
  await act(async () => { respond(socket, "session.activate", workspaceSnapshot({ activeSessionId: other.id })) })
  await settle()
  expect(screen.getByRole("tab", { name: "Checkpoints" }).getAttribute("aria-selected")).toBe("true")
  // Still open: picking a session or an action does not close the column.
  expect(screen.getByRole("complementary", { name: "Sessions" })).toBeTruthy()
})

// Move needs the machine menu on the row's session. Activation is a round
// trip and the thread remounts on it, so the menu opens only once the
// snapshot shows that session active; a refused activation opens nothing.
it("opens the machine menu on the moved session only after it is active, and not after a refusal", async () => {
  const user = userEvent.setup()
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
  const other = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId)!

  await user.click(screen.getByRole("button", { name: `Actions for ${other.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Move to another machine" }))
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
  expect(screen.queryByRole("menu")).toBeNull()
  await act(async () => { fail(socket, "session.activate", { code: -32000, message: "Session is archived" }) })
  await settle()
  expect(screen.queryByRole("menu")).toBeNull()

  await user.click(screen.getByRole("button", { name: `Actions for ${other.title}` }))
  await user.click(screen.getByRole("menuitem", { name: "Move to another machine" }))
  await act(async () => { respond(socket, "session.activate", workspaceSnapshot({ activeSessionId: other.id })) })
  await settle()
  const menu = await screen.findByRole("menu")
  expect(menu.textContent).toContain("Machines")
})
