import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  pendingRequest,
  respond,
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

const composer = /Message the agent|Send to queue for the next turn/

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
  await user.click(screen.getByRole("button", { name: new RegExp(other.title.slice(0, 24)) }))
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
