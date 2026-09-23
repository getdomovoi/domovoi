import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"
import { protocolVersion, type FleetMachine } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { installFakeWebSocket, completeHandshake, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

let sockets: ReturnType<typeof installFakeWebSocket>
beforeEach(() => { globalThis.localStorage?.clear(); sockets = installFakeWebSocket() })
afterEach(() => { cleanup(); sockets.uninstall() })
const settle = () => act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve() })
const machineId = `machine-${"b".repeat(32)}`
const deviceId = `device-${"c".repeat(32)}`
const observedAt = "2026-09-06T00:00:00.000Z"
const transport = { kind: "local", endpoint: "ws://127.0.0.1:49812/rpc", authenticated: true } as const
const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Studio" } }
if (target.project) target.project = { ...target.project, machineId }
const machine: FleetMachine = {
  id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
  connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
  heartbeat: { state: "online", lastSeenAt: observedAt },
  verifiedRoute: { endpoint: "ws://127.0.0.1:49812/rpc", lastAuthenticatedAt: observedAt },
  transports: [transport],
}

// J39: once a machine is admitted, the palette asks it directly for matching
// sessions, and picking one switches this window to that machine.
it("searches an admitted machine from the palette and switches to a picked session", async () => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => { respond(home, "fleet.list", { entries: [{ kind: "machine", machine }] }) })
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(await screen.findByRole("button", { name: "Authorize this client for Studio" }))
  const dialog = screen.getByRole("dialog")
  await user.click(within(dialog).getByLabelText("Client credential"))
  await user.paste("x".repeat(43))
  await user.click(within(dialog).getByRole("button", { name: "Verify client access" }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const proof = sockets.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByText("Client credential verified")).toBeTruthy()
  await user.keyboard("{Escape}")

  await user.keyboard("{Control>}k{/Control}")
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("SESSIONS ON OTHER MACHINES")
  await waitFor(() => expect(sentRequests(home, "fleet.clientRoute")).toHaveLength(2))
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const search = sockets.socket(2)
  await act(async () => { completeHandshake(search, target) })
  await settle()
  await act(async () => { respond(search, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(sentRequests(search, "session.search")[0]?.params).toMatchObject({ query: "billing" })
  await act(async () => { respond(search, "session.search", { query: "billing", truncated: false, matches: [{ session: { ...target.sessions[0]!, id: "s-studio", title: "Billing webhooks on Studio" }, matchedIn: "title" }] }) })
  await settle()
  const group = await screen.findByRole("group", { name: "Studio" })
  expect(group.textContent).toContain("1 match")
  await user.click(within(group).getByText("Billing webhooks on Studio"))
  await waitFor(() => expect(sentRequests(home, "fleet.clientRoute")).toHaveLength(3))
}, 15_000)
