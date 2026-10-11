import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, protocolVersion, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  respond,
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

  // Choosing the attached machine again keeps its connection, so the word
  // stays with it.
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(await screen.findByRole("button", { name: "Terminal on Studio" }))
  await settle()
  expect(chip().textContent).toMatch(/Studiossh$/u)
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
