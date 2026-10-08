import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { fleetSnapshotOverflowErrorCode, maximumFleetEntries, protocolVersion, type FleetMachine } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { installFakeWebSocket, completeHandshake, fail, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

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

// This full-shell journey includes authorization, switching, return, removal
// and renewal. Windows CI exceeded the single-test default even after paste
// replaced per-character input. Keep each request and observation bound intact.
const admissionJourneyTimeoutMs = 15_000
// The card's primary action names the session count it read, when it read one.
const openStudio = /^Open its (\d+ )?sessions? on Studio$/u

it.each(["Open its sessions on Studio", "Terminal on Studio"])("assembles authorization, %s and home return with separate client authority", async (action) => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => { respond(home, "fleet.list", { entries: [{ kind: "machine", machine }] }) })
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  const useButton = await screen.findByRole("button", { name: openStudio })
  await user.click(await screen.findByRole("button", { name: "Authorize this client for Studio" }))
  const dialog = screen.getByRole("dialog")
  // Paste the full generated token as one input event.
  await user.click(within(dialog).getByLabelText("Client credential"))
  await user.paste("x".repeat(43))
  await user.click(within(dialog).getByRole("button", { name: "Verify client access" }))
  await settle()
  expect(sentRequests(home, "fleet.clientRoute")).toHaveLength(1)
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const proof = sockets.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  expect(useButton.hasAttribute("disabled")).toBe(true)
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByText("Client credential verified")).toBeTruthy()
  expect(screen.getByRole("button", { name: openStudio }).hasAttribute("disabled")).toBe(false)
  await user.click(screen.getByRole("button", { name: action === "Terminal on Studio" ? action : openStudio }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const remote = sockets.socket(2)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(sentRequests(remote, "system.hello")[0]?.params).toMatchObject({ authToken: "x".repeat(43), client: "web" })
  expect(home.readyState).toBe(home.OPEN)
  if (action === "Terminal on Studio") {
    await waitFor(() => expect(sentRequests(remote, "terminal.create")).toHaveLength(1), { timeout: 3_000 })
    expect(sentRequests(home, "terminal.create")).toHaveLength(0)
  }
  if (action !== "Terminal on Studio") {
    await act(async () => { remote.drop(1008) })
    await settle()
    expect(screen.getByText(/Client access is no longer verified for/)).toBeTruthy()
    expect(screen.queryByText(/Connecting to.*with this app's client credential/)).toBeNull()
  }
  await user.click(screen.getByRole("button", { name: "Return to home daemon" }))
  expect(remote.readyState).toBe(remote.CLOSED)
  expect(home.readyState).toBe(home.OPEN)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  if (action === "Terminal on Studio") await user.click(screen.getByRole("button", { name: "Remove local access" }))
  expect(screen.getByRole("button", { name: openStudio }).hasAttribute("disabled")).toBe(true)
  if (action === "Terminal on Studio") expect(screen.getByText(/This app no longer holds/).textContent).toContain("Devices list")
  if (action === "Terminal on Studio") {
    await user.click(screen.getByRole("button", { name: "Authorize this client for Studio" }))
    const grant = screen.getByRole("dialog")
    await user.click(within(grant).getByLabelText("Client credential"))
    await user.paste("x".repeat(43))
    await user.click(within(grant).getByRole("button", { name: "Verify client access" }))
    await settle()
    await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
    await settle()
    const renewed = sockets.socket(3)
    await act(async () => { completeHandshake(renewed, target) })
    await settle()
    await act(async () => { respond(renewed, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
    await settle()
    expect(screen.getByText("Client credential verified")).toBeTruthy()
    expect(screen.queryByText(/This app no longer holds/)).toBeNull()
  }
}, admissionJourneyTimeoutMs)

it("reads an admitted machine again when Settings opens, so its providers are current", async () => {
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
  await act(async () => { completeHandshake(sockets.socket(1), target) })
  await settle()
  await act(async () => { respond(sockets.socket(1), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByText("Client credential verified")).toBeTruthy()
  const routes = sentRequests(home, "fleet.clientRoute").length

  // The admission's reading is fresh for 30 seconds; a minute on, a visit reads again.
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000)
  try {
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await settle()
    expect(screen.getByRole("region", { name: "Providers and tokens" })).toBeTruthy()
    expect(sentRequests(home, "fleet.clientRoute")).toHaveLength(routes + 1)
  } finally {
    clock.mockRestore()
  }
}, admissionJourneyTimeoutMs)

it("says in Settings that the fleet list was withheld, rather than listing this machine as the whole fleet", async () => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => {
    fail(home, "fleet.list", {
      code: fleetSnapshotOverflowErrorCode,
      message: "Fleet keyring exceeds the wire limit",
      data: { kind: "fleet-overflow", limit: maximumFleetEntries, totalEntries: 600, entriesNotShown: 600 },
    })
  })
  await settle()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await settle()

  const providers = await screen.findByRole("region", { name: "Providers and tokens" })
  expect(providers.textContent).toContain("Fleet list withheld")
  expect(providers.textContent).toContain("600 entries are not shown")
})

it("renders refusal and leaves Use disabled when the credential is a daemon root", async () => {
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => { respond(home, "fleet.list", { entries: [{ kind: "machine", machine }] }) })
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(screen.getByRole("button", { name: "Authorize this client for Studio" }))
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
  await act(async () => { respond(proof, "device.current", { kind: "daemon", machineId }) })
  await settle()
  expect(within(dialog).getByText("Client access refused")).toBeTruthy()
  expect(within(dialog).getByText(/Do not use a machine credential or daemon root token/)).toBeTruthy()
  expect(dialog.textContent).not.toContain("x".repeat(43))
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("button", { name: openStudio }).hasAttribute("disabled")).toBe(true)
  expect(screen.queryByText("Client credential verified")).toBeNull()
})
