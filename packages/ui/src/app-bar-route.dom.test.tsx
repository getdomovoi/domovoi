import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, protocolVersion, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  pendingRequest,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
const initialWidth = window.innerWidth

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: initialWidth })
})

async function openShell(clientKind: "desktop" | "web", rpcUrl?: string, snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell clientKind={clientKind} {...(rpcUrl ? { rpcUrl } : {})} />)
  await act(async () => {
    completeHandshake(harness.socket(0), snapshot)
  })
}

const machineChip = () => screen.getByRole("button", { name: `Machines: ${demoWorkspace.machine.name}` })

// Web v2 appbar.route-chip and Desktop v2 titlebar.machine-chip: the chip
// names the route, loopback or the tailnet, not local or remote.
describe("the machine chip's route word", () => {
  it.each([
    ["web", "ws://127.0.0.1:47831/rpc", "loopback"],
    ["web", "wss://studio.example.ts.net:47831/rpc", "tailnet"],
    ["web", "wss://192.168.1.20:47831/rpc", "direct"],
    ["web", "ws://192.168.1.20:47831/rpc", "plaintext"],
    ["desktop", "ws://127.0.0.1:47831/rpc", "loopback"],
  ] as const)("a %s client at %s reads %s", async (clientKind, rpcUrl, word) => {
    await openShell(clientKind, rpcUrl)
    // The dot's label is in the button too, for a screen reader; the visible
    // words are the machine's name and then the route.
    expect(machineChip().textContent?.endsWith(`${demoWorkspace.machine.name}${word}`)).toBe(true)
  })
})

// An attached machine names the route this client was given. The fleet entry
// keeps connection "direct" once a route was verified, even when the route
// that answers now is an SSH forward, so the chip must not read the entry.
it("names an SSH forward to an attached machine as ssh, not loopback", async () => {
  const user = userEvent.setup()
  const settle = () => act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve() })
  const machineId = `machine-${"b".repeat(32)}`
  const deviceId = `device-${"c".repeat(32)}`
  const observedAt = "2026-09-06T00:00:00.000Z"
  const transport = { kind: "ssh", endpoint: "ws://127.0.0.1:52011/rpc", authenticated: true, configured: true } as const
  const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Studio" } }
  if (target.project) target.project = { ...target.project, machineId }
  const machine: FleetMachine = {
    id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
    heartbeat: { state: "online", lastSeenAt: observedAt },
    verifiedRoute: { endpoint: "wss://studio.example:47831/rpc", lastAuthenticatedAt: observedAt },
    transports: [transport],
  }
  const limitsRoutes: unknown[] = []
  render(<WorkspaceShell onOpenBrowserLimits={(_opener, route) => limitsRoutes.push(route)} />)
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
  await user.click(screen.getByRole("button", { name: /^Open its (\d+ )?sessions? on Studio$/u }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const remote = harness.socket(2)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  const chip = () => screen.getByRole("button", { name: "Machines: Studio" })
  expect(chip().textContent).toMatch(/Studiossh$/u)

  // The browser limits opened now name the chip's route, not the home
  // endpoint's loopback (the page reads ssh as the route).
  await user.click(screen.getByRole("button", { name: "Open command palette" }))
  await user.type(await screen.findByRole("combobox"), "what a browser tab")
  await user.keyboard("{Enter}")
  expect(limitsRoutes).toEqual(["ssh"])

  // Choosing the attached machine again keeps its connection, so the word
  // stays with it.
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(await screen.findByRole("button", { name: "Terminal on Studio" }))
  await settle()
  expect(chip().textContent).toMatch(/Studiossh$/u)
}, 15_000)

// The browser limits name the route the chip names: nothing while an attach
// has not resolved its route (never the home loopback), then the attached
// machine's own route, here the tailnet.
it("hands the browser limits no route while an attach resolves, then the attached tailnet", async () => {
  const user = userEvent.setup()
  const settle = () => act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve() })
  const machineId = `machine-${"b".repeat(32)}`
  const deviceId = `device-${"c".repeat(32)}`
  const observedAt = "2026-09-06T00:00:00.000Z"
  const transport = { kind: "tailnet", endpoint: "wss://studio.example.ts.net:47831/rpc", authenticated: true } as const
  const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Studio" } }
  if (target.project) target.project = { ...target.project, machineId }
  const machine: FleetMachine = {
    id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    connection: "tailnet", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
    heartbeat: { state: "online", lastSeenAt: observedAt },
    verifiedRoute: { endpoint: transport.endpoint, lastAuthenticatedAt: observedAt },
    transports: [transport],
  }
  const limitsRoutes: unknown[] = []
  const openLimits = async () => {
    await user.click(screen.getByRole("button", { name: "Open command palette" }))
    await user.type(await screen.findByRole("combobox"), "what a browser tab")
    await user.keyboard("{Enter}")
    await settle()
  }
  render(<WorkspaceShell onOpenBrowserLimits={(_opener, route) => limitsRoutes.push(route)} />)
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
  await user.click(screen.getByRole("button", { name: /^Open its (\d+ )?sessions? on Studio$/u }))
  await settle()

  // The attach has asked for its route and has none yet.
  await openLimits()
  expect(limitsRoutes).toEqual([undefined])

  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const remote = harness.socket(2)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  expect(screen.getByRole("button", { name: "Machines: Studio" }).textContent).toMatch(/Studiotailnet$/u)
  await openLimits()
  expect(limitsRoutes).toEqual([undefined, "tailnet"])
}, 15_000)

// A route resolution abandoned by a return home can land after the machine
// was attached again over another route. The word is the live socket's, also
// when both routes share one endpoint URL.
it.each([
  ["another endpoint", { kind: "lan", endpoint: "wss://studio.example:47831/rpc", authenticated: true } as const, "direct"],
  ["the same endpoint", { kind: "local", endpoint: "ws://127.0.0.1:52011/rpc", authenticated: true } as const, "loopback"],
])("keeps the live route's word when an abandoned route answers late, over %s", async (_case, tls, word) => {
  const user = userEvent.setup()
  const settle = () => act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve() })
  const machineId = `machine-${"b".repeat(32)}`
  const deviceId = `device-${"c".repeat(32)}`
  const observedAt = "2026-09-06T00:00:00.000Z"
  const ssh = { kind: "ssh", endpoint: "ws://127.0.0.1:52011/rpc", authenticated: true, configured: true } as const
  const target = { ...workspaceSnapshot(), machine: { ...workspaceSnapshot().machine, id: machineId, name: "Studio" } }
  if (target.project) target.project = { ...target.project, machineId }
  const machine: FleetMachine = {
    id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
    heartbeat: { state: "online", lastSeenAt: observedAt },
    verifiedRoute: { endpoint: tls.endpoint, lastAuthenticatedAt: observedAt },
    transports: [tls, ssh],
  }
  const answer = (socket: ReturnType<typeof harness.socket>, id: ReturnType<typeof pendingRequest>["id"], result: unknown) => {
    socket.answered.add(id)
    socket.receive({ jsonrpc: "2.0", id, result })
  }
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
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport: tls }) })
  await settle()
  const proof = harness.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  const openStudio = /^Open its (\d+ )?sessions? on Studio$/u

  await user.click(screen.getByRole("button", { name: openStudio }))
  await settle()
  const abandoned = pendingRequest(home, "fleet.clientRoute")
  await user.click(screen.getByRole("button", { name: "Return to home daemon" }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(await screen.findByRole("button", { name: openStudio }))
  await settle()
  const current = sentRequests(home, "fleet.clientRoute").filter((request) => !home.answered.has(request.id) && request.id !== abandoned.id).at(-1)
  expect(current).toBeTruthy()
  await act(async () => { answer(home, current!.id, { outcome: "ready", machineId, transport: tls }) })
  await settle()
  let last = 0
  while ((() => { try { harness.socket(last + 1); return true } catch { return false } })()) last += 1
  const remote = harness.socket(last)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  const chip = () => screen.getByRole("button", { name: "Machines: Studio" })
  expect(chip().textContent?.endsWith(`Studio${word}`)).toBe(true)

  await act(async () => { answer(home, abandoned.id, { outcome: "ready", machineId, transport: ssh }) })
  await settle()
  expect(chip().textContent).not.toMatch(/ssh$/u)
  expect(chip().textContent?.endsWith(`Studio${word}`)).toBe(true)
}, 15_000)

// Q362 A: the theme is a preference of this client that never reaches the
// daemon, so a watching client keeps it.
it("keeps the theme toggle live while watching", async () => {
  const user = userEvent.setup()
  await openShell("desktop", undefined, { ...workspaceSnapshot(), clientAccess: "watching" })
  const toggle = screen.getByRole("button", { name: /^Use (light|dark) theme$/ })
  const before = toggle.getAttribute("aria-label")
  expect(toggle.hasAttribute("disabled")).toBe(false)
  await user.click(toggle)
  expect(screen.getByRole("button", { name: /^Use (light|dark) theme$/ }).getAttribute("aria-label")).not.toBe(before)
})

// Q384 A: the web opens the sessions column by default at wide widths, as the
// Web v2 frame draws it. A narrow tab and the desktop keep it behind its button.
describe("the sessions column's first state", () => {
  const sessionsColumn = () => screen.queryByRole("complementary", { name: "Sessions" })

  it("is open in a wide browser tab", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await openShell("web")
    expect(sessionsColumn()).not.toBeNull()
  })

  it("is closed in a narrow browser tab", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 })
    await openShell("web")
    expect(sessionsColumn()).toBeNull()
  })

  it("is closed in the desktop at any width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await openShell("desktop")
    expect(sessionsColumn()).toBeNull()
  })
})
