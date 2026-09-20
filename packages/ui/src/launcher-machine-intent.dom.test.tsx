import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { protocolVersion, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it } from "vitest"
import { WorkspaceShell } from "./workspace-shell"
import { installFakeWebSocket, completeHandshake, respond, workspaceSnapshot } from "./test-support/fake-websocket"

let sockets: ReturnType<typeof installFakeWebSocket>
beforeEach(() => { globalThis.localStorage?.clear(); sockets = installFakeWebSocket() })
afterEach(() => { cleanup(); sockets.uninstall() })
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const machineId = `machine-${"b".repeat(32)}`
const deviceId = `device-${"c".repeat(32)}`
const observedAt = "2026-09-06T00:00:00.000Z"
const transport = { kind: "local", endpoint: "ws://127.0.0.1:49812/rpc", authenticated: true } as const
const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Review destination host" } }
if (target.project) target.project = { ...target.project, machineId }
const machine: FleetMachine = {
  id: machineId, label: "Review destination host", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
  connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
  heartbeat: { state: "online", lastSeenAt: observedAt },
  verifiedRoute: { endpoint: transport.endpoint, lastAuthenticatedAt: observedAt }, transports: [transport],
}

it("cancels a machine-specific launch when the user returns home before attachment completes", async () => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => { respond(home, "fleet.list", { entries: [{ kind: "machine", machine }] }) })
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(screen.getByRole("button", { name: /Machines and daemons/u }))
  await user.click(screen.getByRole("button", { name: "Authorize this client for Review destination host" }))
  const grant = screen.getByRole("dialog")
  await user.click(within(grant).getByLabelText("Client credential"))
  await user.paste("x".repeat(43))
  await user.click(within(grant).getByRole("button", { name: "Verify client access" }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const proof = sockets.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByText("Client credential verified")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Open command palette" }))
  await user.click(screen.getByRole("combobox"))
  await user.paste("Review destination host")
  await user.keyboard("{Control>}{Enter}{/Control}")
  await settle()
  expect(screen.queryByRole("dialog", { name: "Start a session" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "Return to home daemon" }))
  await settle()
  expect(screen.queryByRole("dialog", { name: "Start a session" })).toBeNull()
})
