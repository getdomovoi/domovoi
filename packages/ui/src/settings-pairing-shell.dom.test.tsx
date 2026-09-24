import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, notify, pendingRequest, sentRequests, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

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

it("lists paired devices once while snapshots stream in", async () => {
  render(<WorkspaceShell clientKind="desktop" />)
  const socket = harness.socket(0)
  const snapshot = workspaceSnapshot()
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  await screen.findByRole("button", { name: "Show a pairing code" })
  await settle()
  const before = sentRequests(socket, "device.list").length
  expect(before).toBeGreaterThan(0)
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { notify(socket, "workspace.changed", { ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session, updatedAt: new Date(Date.UTC(2026, 8, 23, 12, index)).toISOString() })) }) })
    await settle()
  }
  expect(sentRequests(socket, "device.list")).toHaveLength(before)
})
