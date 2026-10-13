import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

async function deviceNote() {
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Attach" }))
  return within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Image or file from this device/u }).textContent
}

// The same rule as the lost banner's last heard: the desktop app's own daemon
// on this machine, dialled on loopback.
it("says nothing leaves this computer in the desktop app on its own daemon", async () => {
  render(<WorkspaceShell clientKind="desktop" localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} />)

  expect(await deviceNote()).toContain("That is this computer, so nothing leaves it.")
})

// A tab's loopback address can be the local end of an SSH forward to another
// machine, so a tab never claims the bytes stay here.
it("does not say nothing leaves in a browser on a loopback address", async () => {
  render(<WorkspaceShell />)

  const note = await deviceNote()
  expect(note).toContain("with the next message.")
  expect(note).not.toContain("nothing leaves it")
})
