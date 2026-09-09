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
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
})

// The shell does not update `pinned` in place: it unmounts the floating sheet
// and renders the dock inside a resizable panel. That unmount runs the sheet's
// focus-return cleanup, so without shell coordination the keyboard lands back
// on whatever opened the sheet instead of on the pinned dock.
it("keeps focus on the pinned dock rather than the opener", async () => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  await act(async () => {
    completeHandshake(harness.socket(0), workspaceSnapshot())
  })
  await settle()

  const opener = screen.getByRole("button", { name: "Changes" })
  await user.click(opener)
  await settle()

  await user.click(screen.getByRole("button", { name: "Pin" }))
  await settle()

  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()
  expect(document.activeElement).not.toBe(opener)
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Unpin" }))
})
