import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const quarantinedPath = "/Users/person/.domovoi/state.sqlite.snapshot-corrupt-2026-09-22T12-00-00-000Z.json"

it("shows the stored state the daemon moved aside until it is dismissed", async () => {
  render(<WorkspaceShell />)
  await act(async () => {
    completeHandshake(harness.socket(0), {
      ...workspaceSnapshot(),
      stateRecovery: {
        kind: "snapshot",
        quarantinedPath,
        reason: "ZodError: sessions is invalid",
        occurredAt: "2026-09-22T12:00:00.000Z",
        pairedDevicesKept: true,
      },
    })
  })
  await settle()
  const notice = screen.getByText("Stored workspace could not be read").closest("[data-slot=alert]")
  expect(notice?.textContent).toContain(quarantinedPath)
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
  expect(screen.queryByText("Stored workspace could not be read")).toBeNull()
})

it("shows nothing when the daemon read its stored state", async () => {
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
  expect(screen.queryByText(/could not be read/)).toBeNull()
})
