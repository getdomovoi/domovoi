import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
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
  await act(async () => {
    completeHandshake(harness.socket(0), snapshot)
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

  expect(screen.getByPlaceholderText(composer)).toBeTruthy()
})
