import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { protocolVersion, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it } from "vitest"
import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, fail, installFakeWebSocket, notify, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

let sockets: ReturnType<typeof installFakeWebSocket>
beforeEach(() => { globalThis.localStorage?.clear(); sockets = installFakeWebSocket() })
afterEach(() => { cleanup(); sockets.uninstall() })
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const machineId = `machine-${"b".repeat(32)}`
const machine: FleetMachine = {
  id: machineId, label: "Review destination", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
  connection: "tailnet", health: "healthy", self: false, capabilities: ["sessions"],
  heartbeat: { state: "online", lastSeenAt: "2026-09-13T00:00:00.000Z" },
  transports: [{ kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true }],
}
async function setup() {
  const snapshot = workspaceSnapshot()
  snapshot.sessions = snapshot.sessions.slice(0, 2).map((session, index) => {
    const { activeTurnId: _active, ...rest } = session
    return { ...rest, title: index ? "Review chosen session" : "Review previous session", state: "idle" as const, workspacePath: `/worktrees/${session.id}` }
  })
  expect(snapshot.sessions).toHaveLength(2)
  snapshot.activeSessionId = snapshot.sessions[0]!.id
  snapshot.approvals = []
  render(<WorkspaceShell />)
  const socket = sockets.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  await act(async () => { respond(socket, "fleet.list", { entries: [{ kind: "machine", machine }] }) })
  const user = userEvent.setup()
  return { socket, snapshot, user }
}
async function pick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: "Open command palette" }))
  await user.click(screen.getByRole("combobox"))
  await user.paste(title)
  await user.keyboard("{Control>}{Enter}{/Control}")
  await user.click(screen.getByRole("option", { name: /Review destination/ }))
  await settle()
}

it("waits for the selected session before issuing transfer preflight", async () => {
  const { socket, snapshot, user } = await setup()
  await pick(user, "Review chosen session")
  expect(sentRequests(socket, "session.activate")[0]?.params).toMatchObject({ sessionId: snapshot.sessions[1]!.id })
  expect(sentRequests(socket, "session.transferPreview")).toHaveLength(0)
})

it("drops transfer intent when selected-session activation is refused", async () => {
  const { socket, user } = await setup()
  await pick(user, "Review chosen session")
  await act(async () => { fail(socket, "session.activate", { code: -32000, message: "Activation denied" }) })
  await settle()
  expect(screen.getByText("Activation denied")).toBeTruthy()
  expect(screen.queryByRole("dialog", { name: /Move session to Review destination/ })).toBeNull()
})

it("does not carry the selected target into another active session", async () => {
  const { socket, snapshot, user } = await setup()
  await pick(user, "Review previous session")
  await act(async () => { respond(socket, "session.activate", snapshot) })
  await settle()
  await act(async () => { notify(socket, "workspace.changed", { ...snapshot, activeSessionId: snapshot.sessions[1]!.id }) })
  await settle()
  expect(sentRequests(socket, "session.transferPreview").every((request) => (request.params as { sessionId?: string } | undefined)?.sessionId === snapshot.sessions[0]!.id)).toBe(true)
})

it("opens preflight for the selected session after successful activation", async () => {
  const { socket, snapshot, user } = await setup()
  await pick(user, "Review chosen session")
  await act(async () => { respond(socket, "session.activate", { ...snapshot, activeSessionId: snapshot.sessions[1]!.id }) })
  await settle()
  expect(sentRequests(socket, "session.transferPreview")).toHaveLength(1)
  expect(sentRequests(socket, "session.transferPreview")[0]?.params).toMatchObject({ sessionId: snapshot.sessions[1]!.id, targetMachineId: machineId })
})

it("does not revive transfer intent when a previously active session returns", async () => {
  const { socket, snapshot, user } = await setup()
  await pick(user, "Review previous session")
  await act(async () => { respond(socket, "session.activate", snapshot) })
  await settle()
  expect(sentRequests(socket, "session.transferPreview")).toHaveLength(1)
  await act(async () => { notify(socket, "workspace.changed", { ...snapshot, activeSessionId: snapshot.sessions[1]!.id }) })
  await settle()
  expect(screen.queryByRole("dialog", { name: /Move session to Review destination/ })).toBeNull()
  await act(async () => { notify(socket, "workspace.changed", snapshot) })
  await settle()
  expect(sentRequests(socket, "session.transferPreview")).toHaveLength(1)
  expect(screen.queryByRole("dialog", { name: /Move session to Review destination/ })).toBeNull()
})
