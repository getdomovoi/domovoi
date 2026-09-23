import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, pendingRequest, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

it("asks its own daemon for a pairing code from Settings", async () => {
  render(<WorkspaceShell clientKind="desktop" />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  await user.click(await screen.findByRole("button", { name: "Show a pairing code" }))
  await settle()
  expect(pendingRequest(socket, "device.issueCode").params).toMatchObject({ targetClient: "phone" })
})
