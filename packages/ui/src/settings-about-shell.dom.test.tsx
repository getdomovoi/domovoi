import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, respond, sentRequests, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// J10: Settings reads the daemon's own build facts through update.status.
it("asks the daemon for its build and draws it under About this build", async () => {
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  const snapshot = workspaceSnapshot()
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  expect(sentRequests(socket, "update.status")).toHaveLength(1)
  await act(async () => { respond(socket, "update.status", { channel: "stable", currentVersion: snapshot.machine.version, currentSourceCommit: "3f8b01d".padEnd(40, "0"), state: "idle" }) })
  await settle()
  const section = screen.getByRole("region", { name: "About this build" })
  expect(section.textContent).toContain(`domovoid ${snapshot.machine.version} · 3f8b01d`)
  expect(section.textContent).toContain("Not signed")
})
