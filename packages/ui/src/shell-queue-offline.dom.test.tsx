// A queued message waits for its turn to end. With the daemon lost it also
// waits for the daemon: released offline it would fail on a closed socket and
// come back as a failed attempt instead of staying queued.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake, installFakeWebSocket, notify, respond, sentRequests, workspaceSnapshot,
  type FakeWebSocketHarness, type FakeWebSocket,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage?.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => { cleanup(); harness?.uninstall() })

const settle = () => act(async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
})
function running() {
  const value = workspaceSnapshot()
  value.approvals = []
  value.artifacts = []
  value.annotations = []
  value.sessions.forEach((session) => { session.activeTurnId = `turn-${session.id}`; session.state = "active" })
  return workspaceSnapshotSchema.parse(value)
}
function idle(value: WorkspaceSnapshot) {
  const next = structuredClone(value)
  const session = next.sessions.find((candidate) => candidate.id === value.activeSessionId)!
  delete session.activeTurnId
  session.state = "idle"
  return workspaceSnapshotSchema.parse(next)
}
async function loadCatalog(socket: FakeWebSocket, value: WorkspaceSnapshot) {
  await act(async () => {
    respond(socket, "skill.list", [])
    const { id, name, platform, arch, version } = value.machine
    respond(socket, "skill.inventory", { machine: { id, name, platform, arch, version }, skills: [] })
  })
}
const sends = () => harness.sockets.flatMap((socket) => sentRequests(socket, "session.send"))

it("holds a queued message while the daemon is lost and releases it once on return", async () => {
  const value = running()
  render(<WorkspaceShell />)
  const first = harness.socket(0)
  await act(async () => completeHandshake(first, value))
  await loadCatalog(first, value)
  await settle()
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "after the link returns" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(screen.getByText("after the link returns")).toBeTruthy()

  // The turn ends and the link drops in the same render.
  await act(async () => {
    notify(first, "workspace.changed", idle(value))
    first.drop()
  })
  await settle()

  expect(sends()).toHaveLength(0)
  expect(screen.getByText("after the link returns")).toBeTruthy()
  expect(screen.getByText("queued")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /^(Send anyway|Queue again)$/u })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
  await settle()
  const second = harness.sockets.at(-1)!
  expect(second).not.toBe(first)
  await act(async () => completeHandshake(second, idle(value)))
  await loadCatalog(second, value)
  await settle()
  await settle()

  expect(sends()).toHaveLength(1)
  expect(sends()[0]?.params).toMatchObject({ sessionId: value.activeSessionId, prompt: "after the link returns" })
})
