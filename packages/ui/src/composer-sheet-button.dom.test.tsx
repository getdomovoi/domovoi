import { act, cleanup, render, screen, within } from "@testing-library/react"
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

const start = async () => {
  render(<WorkspaceShell />)
  await act(async () => {
    completeHandshake(harness.socket(0), workspaceSnapshot())
  })
  await settle()
}

const actionRow = () => {
  const row = document.querySelector("[data-workspace-composer-actions]")
  if (!row) throw new Error("The composer draws no action row")
  return row as HTMLElement
}

// v2 opens the machine surfaces from the composer itself. Without this control
// the sheet is reachable only from the palette and the thread, which is how the
// removed dock rail came to be the only visible way back in.
it("opens the sheet from the composer action row", async () => {
  const user = userEvent.setup()
  await start()

  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()

  const open = within(actionRow()).getByRole("button", { name: "Open the sheet" })
  await user.click(open)
  await settle()

  const sheet = screen.getByRole("region", { name: "Machine surfaces" })
  expect(within(sheet).getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
})

// The design draws the opener between the mode chip and the spacer, so the row
// reads left to right as what you are sending with, then where you look.
it("draws the opener after the mode chip", async () => {
  await start()

  const row = actionRow()
  const open = within(row).getByRole("button", { name: "Open the sheet" })
  const mode = within(row).getByRole("button", { name: /^Mode: /u })
  expect(mode.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
