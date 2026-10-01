import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"
import { protocolVersion, type FleetMachine } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, notify, respond, sentRequests, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

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
  await screen.findByRole("region", { name: "About this build" })
  await settle()
  expect(sentRequests(socket, "update.status")).toHaveLength(1)
  await act(async () => { respond(socket, "update.status", { channel: "stable", currentVersion: snapshot.machine.version, currentSourceCommit: "3f8b01d".padEnd(40, "0"), state: "idle" }) })
  await settle()
  const section = screen.getByRole("region", { name: "About this build" })
  expect(section.textContent).toContain(`domovoid ${snapshot.machine.version} · 3f8b01d`)
  expect(section.textContent).toContain("Not signed")
})

// A workspace change re-renders the shell; the build facts are read once.
it("keeps one update.status read while the workspace changes under Settings", async () => {
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  const snapshot = workspaceSnapshot()
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("region", { name: "About this build" })
  await settle()
  await act(async () => { respond(socket, "update.status", { channel: "stable", currentVersion: snapshot.machine.version, currentSourceCommit: "3f8b01d".padEnd(40, "0"), state: "idle" }) })
  for (let index = 0; index < 4; index += 1) {
    const changed = structuredClone(snapshot)
    changed.machine.name = `renamed ${index}`
    await act(async () => { notify(socket, "workspace.changed", changed) })
    await settle()
  }
  expect(sentRequests(socket, "update.status")).toHaveLength(1)
})

// Attached to another machine, Settings describes that machine, whose build
// the home daemon's update.status cannot speak for. One line, one daemon: the
// section stays hidden while attached, as the local daemon row does.
it("hides About this build while attached to another machine", async () => {
  const machineId = `machine-${"b".repeat(32)}`
  const deviceId = `device-${"c".repeat(32)}`
  const observedAt = "2026-09-06T00:00:00.000Z"
  const transport = { kind: "local", endpoint: "ws://127.0.0.1:49812/rpc", authenticated: true } as const
  const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Studio", version: "9.9.9" } }
  if (target.project) target.project = { ...target.project, machineId }
  const machine: FleetMachine = {
    id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "9.9.9", protocolVersion,
    connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
    heartbeat: { state: "online", lastSeenAt: observedAt },
    verifiedRoute: { endpoint: "ws://127.0.0.1:49812/rpc", lastAuthenticatedAt: observedAt },
    transports: [transport],
  }
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = harness.socket(0)
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
  const proof = harness.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  await user.click(screen.getByRole("button", { name: "Use Studio" }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const remote = harness.socket(2)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByText(/with this app's client credential/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("region", { name: "Providers and tokens" })
  await settle()
  expect(screen.queryByRole("region", { name: "About this build" })).toBeNull()
}, 15_000)
