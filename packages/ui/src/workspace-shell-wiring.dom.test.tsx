import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { daemonAuthenticationErrorCode, phoneAndTabletRpcMethods, protocolVersion, rpcMethodAuthorizations, type FleetMachine, type RpcMethod } from "@getdomovoi/protocol"

import type { DesktopWindowBridge } from "./desktop-platform"
import { terminalIdForSession } from "./terminal-id"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// The shell is where a view's props come from. Each test here renders the
// whole WorkspaceShell, so it fails when the view can do a thing but the shell
// never hands it what it needs.

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

type Hello = ReturnType<typeof workspaceSnapshot>

async function openWorkspace(snapshot: Hello, props: Parameters<typeof WorkspaceShell>[0] = {}) {
  render(<WorkspaceShell {...props} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return socket
}

function withThreadItem(item: Record<string, unknown>): Hello {
  const snapshot = workspaceSnapshot()
  return workspaceSnapshot({
    approvals: [],
    thread: [
      ...snapshot.thread,
      { sessionId: snapshot.activeSessionId, createdAt: "2026-10-08T09:00:00.000Z", ...item },
    ],
  } as Partial<Hello>)
}

const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-label")

// Q346 A: a browser downloads the export to the device it runs on, so the line
// under Export this query cannot say it writes a file on the machine.
describe("the audit log's export line", () => {
  it("says a browser saves the file to this device", async () => {
    await openWorkspace(workspaceSnapshot(), { clientKind: "web" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Audit log/ }))
    await screen.findByRole("heading", { level: 1, name: "Audit log" })

    expect(screen.getByText(/^saves to this device · /u)).toBeTruthy()
    expect(screen.queryByText(/writes a file on this machine/u)).toBeNull()
  })
})

// A browser tab holds a device credential, and the daemon refuses
// device.rename, device.rotate and device.revoke from one by closing the
// connection. The tab lists its daemon's devices but never sends those three.
describe("paired devices in a browser tab", () => {
  it("a web tab lists them and never sends a rename, rotation or unpairing", async () => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind: "web" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
    await waitFor(() => expect(sentRequests(socket, "device.list")).not.toHaveLength(0))
    await act(async () => {
      respond(socket, "device.list", { devices: [{
        id: `device-${"d".repeat(32)}`,
        label: "kitchen-phone",
        pairedAt: "2026-10-01T09:00:00.000Z",
        binding: { kind: "client", client: "phone", clientAccess: "full" },
      }] })
    })
    const row = await screen.findByRole("row", { name: /kitchen-phone/u })

    for (const name of ["Rename kitchen-phone", "Rotate the credential on kitchen-phone", "Unpair kitchen-phone"]) {
      const control = within(row).getByRole("button", { name })
      expect(control).toHaveProperty("disabled", true)
      await user.click(control)
    }
    await settle()

    expect(row.textContent).toContain(`Rename, Rotate and Unpair are off in a browser tab: they need the daemon's own credential. Use the desktop app on ${snapshot.machine.name}.`)
    expect(sentRequests(socket, "device.rename")).toEqual([])
    expect(sentRequests(socket, "device.rotate")).toEqual([])
    expect(sentRequests(socket, "device.revoke")).toEqual([])
    expect(socket.readyState).toBe(socket.OPEN)
  })

  // On a handheld browser the web app greets as phone or tablet, and the
  // daemon refuses device.list from that credential too (phoneAndTabletRpcMethods).
  it.each(["phone", "tablet"] as const)("a %s tab sends no device request at all", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
    await screen.findByText(`Paired devices are off in a phone or tablet tab: the daemon does not list them for a phone or tablet credential. Use the desktop app on ${snapshot.machine.name}.`)
    await settle()

    for (const method of ["device.list", "device.rename", "device.rotate", "device.revoke"] as const) {
      expect(sentRequests(socket, method)).toEqual([])
    }
    expect(socket.readyState).toBe(socket.OPEN)
  })
})

// Machines in a tab whose credential the daemon refuses fleet.enroll,
// fleet.forget, fleet.clientRoute or terminal.create for. The daemon answers
// each with the authentication error, on which the client closes its
// connection, so the tab never sends one.
describe("Machines in a browser tab", () => {
  const observedAt = "2026-10-01T09:00:00.000Z"
  const fleetMachine = (overrides: Partial<FleetMachine> & Pick<FleetMachine, "id" | "label" | "self">): FleetMachine => ({
    platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    connection: "direct", health: "healthy", capabilities: ["sessions", "terminals"],
    heartbeat: { state: "online", lastSeenAt: observedAt },
    transports: [{ kind: "local", endpoint: "ws://127.0.0.1:49812/rpc", authenticated: true }],
    verifiedRoute: { endpoint: "ws://127.0.0.1:49812/rpc", lastAuthenticatedAt: observedAt },
    ...overrides,
  })

  async function openMachines(clientKind: "web" | "phone" | "tablet") {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    await act(async () => {
      respond(socket, "fleet.list", { entries: [
        { kind: "machine", machine: (({ verifiedRoute: _route, ...self }) => self)(fleetMachine({ id: snapshot.machine.id, label: snapshot.machine.name, self: true, connection: "local" })) },
        { kind: "machine", machine: fleetMachine({ id: `machine-${"b".repeat(32)}`, label: "Studio", self: false }) },
      ] })
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
    await screen.findByRole("group", { name: "Studio" })
    return { snapshot, socket, user }
  }

  it.each(["web", "phone", "tablet"] as const)("a %s tab never sends fleet.enroll or fleet.forget", async (clientKind) => {
    const { snapshot, socket, user } = await openMachines(clientKind)
    const pair = screen.getByRole("button", { name: "Pair a machine" })
    const forget = within(screen.getByRole("group", { name: "Studio" })).getByRole("button", { name: "Forget Studio" })

    for (const control of [pair, forget]) {
      expect(control).toHaveProperty("disabled", true)
      await user.click(control)
    }
    await settle()

    expect(screen.getByText(`Pair a machine and Forget are off in a browser tab: they need the daemon's own credential. Use the desktop app on ${snapshot.machine.name}.`)).toBeTruthy()
    expect(sentRequests(socket, "fleet.enroll")).toEqual([])
    expect(sentRequests(socket, "fleet.forget")).toEqual([])
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it.each(["phone", "tablet"] as const)("a %s tab never sends fleet.clientRoute or terminal.create", async (clientKind) => {
    const { snapshot, socket, user } = await openMachines(clientKind)
    const authorize = within(screen.getByRole("group", { name: "Studio" })).getByRole("button", { name: "Authorize this client for Studio" })
    const terminal = within(screen.getByRole("group", { name: snapshot.machine.name })).getByRole("button", { name: `Terminal on ${snapshot.machine.name}` })

    for (const control of [authorize, terminal]) {
      expect(control).toHaveProperty("disabled", true)
      await user.click(control)
    }
    await settle()

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sentRequests(socket, "fleet.clientRoute")).toEqual([])
    expect(sentRequests(socket, "terminal.create")).toEqual([])
    expect(harness.sockets).toHaveLength(1)
    expect(socket.readyState).toBe(socket.OPEN)
  })

  // The machine menu the sessions drawer opens offers Pair a machine too, and
  // that sends fleet.enroll on the same home connection.
  async function openMachineMenu(clientKind: "desktop" | "web" | "phone" | "tablet") {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^Sessions \d/u }))
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    await user.click(screen.getByRole("button", { name: `Actions for ${active.title}` }))
    await user.click(screen.getByRole("menuitem", { name: "Move to another machine" }))
    await settle()
    const menu = await screen.findByRole("menu")
    return { socket, menu }
  }

  it.each(["web", "phone", "tablet"] as const)("a %s tab's machine menu offers no Pair a machine and sends no fleet.enroll", async (clientKind) => {
    const { socket, menu } = await openMachineMenu(clientKind)
    expect(menu.textContent).toContain("Machines")
    expect(within(menu).queryByRole("menuitem", { name: "+ Pair a machine" })).toBeNull()
    await settle()
    expect(sentRequests(socket, "fleet.enroll")).toEqual([])
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it("the desktop app's machine menu still offers Pair a machine", async () => {
    const { menu } = await openMachineMenu("desktop")
    expect(within(menu).getByRole("menuitem", { name: "+ Pair a machine" })).toBeTruthy()
  })

  // The daemon routes a web credential and opens a shell for it.
  it("a web tab keeps Authorize this client and Terminal", async () => {
    const { snapshot } = await openMachines("web")
    expect(within(screen.getByRole("group", { name: "Studio" })).getByRole("button", { name: "Authorize this client for Studio" })).toHaveProperty("disabled", false)
    expect(within(screen.getByRole("group", { name: snapshot.machine.name })).getByRole("button", { name: `Terminal on ${snapshot.machine.name}` })).toHaveProperty("disabled", false)
  })
})

// The receipt's link and the refusal card's link name a dock tab. The shell
// is what opens it.
describe("thread links that name a dock tab", () => {
  it("opens Checkpoints from the latest receipt's See the checkpoints", async () => {
    await openWorkspace(withThreadItem({
      id: "receipt-wiring",
      kind: "receipt",
      decision: "allow-once",
      operation: "pnpm prisma migrate deploy",
      checkpoint: "ckpt_7f24",
      client: "desktop",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See the checkpoints/u }))
    await settle()

    expect(selectedTab()).toBe("Checkpoints")
  })

  it("opens Rules from an Always receipt's See the rule", async () => {
    await openWorkspace(withThreadItem({
      id: "receipt-wiring",
      kind: "receipt",
      decision: "always-project",
      operation: "pnpm prisma migrate deploy",
      checkpoint: "ckpt_7f24",
      client: "desktop",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See the rule/u }))
    await settle()

    expect(selectedTab()).toBe("Rules")
  })

  it("opens Rules from a policy refusal's See what a rule can never cover", async () => {
    await openWorkspace(withThreadItem({
      id: "policy-refusal-wiring",
      kind: "policy-refusal",
      operation: "Deploy the billing service to production",
      command: "pnpm -w deploy --env production",
      rule: "No deploys from an agent turn",
      setBy: "acme-eng owner, 2026-08-14",
      scope: "every machine in acme-eng",
      remedy: "Run it yourself from the deploy runbook, or ask an owner to retire the rule.",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See what a rule can never cover/u }))
    await settle()

    expect(selectedTab()).toBe("Rules")
  })
})

// A watching desktop cannot hold the shell, but it can read it through
// terminal.watch the way the phone does, instead of an empty state.
describe("the Terminal tab on a watching desktop", () => {
  it("watches the session's shell", async () => {
    const snapshot = workspaceSnapshot({ clientAccess: "watching" } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind: "desktop" })
    const user = userEvent.setup()
    const open = screen.queryByRole("button", { name: "Open the sheet" })
    if (open) await user.click(open)
    await settle()
    await user.click(screen.getByRole("tab", { name: "Terminal" }))
    await waitFor(() => expect(sentRequests(socket, "terminal.watch")).toHaveLength(1))
    await settle()

    expect(sentRequests(socket, "terminal.watch").at(-1)?.params).toMatchObject({
      terminalId: terminalIdForSession(snapshot.activeSessionId!),
    })
    expect(sentRequests(socket, "terminal.create")).toEqual([])
  })
})

// The Desktop V2 frame links Permissions and rules and Checkpoints from
// Settings' Elsewhere to the sheet tabs that own them, one click away.
describe("Settings' links to the sheet", () => {
  it("opens Rules from Permissions and rules", async () => {
    await openWorkspace(workspaceSnapshot())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /^Permissions and rules/u }))
    await settle()

    expect(selectedTab()).toBe("Rules")
  })

  it("opens Checkpoints from Checkpoints", async () => {
    await openWorkspace(workspaceSnapshot())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /^Checkpoints/u }))
    await settle()

    expect(selectedTab()).toBe("Checkpoints")
  })
})

// Q362 A: theme, Appearance and Notifications stay on this client, so a
// watching window changes them, and nothing about them reaches the daemon.
describe("this client's own preferences on a watching window", () => {
  it("saves a theme and a notification change locally and sends nothing", async () => {
    const socket = await openWorkspace(workspaceSnapshot({ clientAccess: "watching" } as Partial<Hello>), { clientKind: "desktop" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    const before = sentRequests(socket).length

    await user.click(within(await screen.findByRole("radiogroup", { name: "Theme" })).getByRole("radio", { name: /Light/u }))
    await user.click(screen.getByRole("switch", { name: "Completions" }))
    await settle()

    const saved = JSON.parse(localStorage.getItem(workspaceUiStorageKey) ?? "{}") as { theme?: string; notifications?: Record<string, boolean> }
    expect(saved.theme).toBe("light")
    expect(saved.notifications).toEqual({ completion: false, failure: true, approvalNeeded: true })
    expect(screen.getByRole("switch", { name: "Completions" }).getAttribute("aria-checked")).toBe("false")
    expect(sentRequests(socket).slice(before)).toEqual([])
  })
})

describe("window decoration on a watching desktop", () => {
  it("hands the change to the desktop, which saves it in its own file", async () => {
    const setWindowDecoration = vi.fn(async () => true)
    const windowBridge: DesktopWindowBridge = {
      platform: "linux",
      getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
      captureAnnotation: async () => { throw new Error("not in this test") },
      notify: async () => true,
      onNotificationActivate: () => () => {},
      openDirectory: async () => ({ status: "cancelled" as const }),
      readClipboardText: async () => "",
      writeClipboardText: async () => true,
      openExternal: async () => true,
      onDeepLink: () => () => {},
      getWindowDecoration: async () => "domovoi",
      setWindowDecoration,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
    }
    const socket = await openWorkspace(workspaceSnapshot({ clientAccess: "watching" } as Partial<Hello>), { clientKind: "desktop", windowBridge })
    const user = userEvent.setup()
    const skip = screen.queryByRole("button", { name: "Skip for now" })
    if (skip) { await user.click(skip); await settle() }
    await user.click(screen.getByRole("button", { name: "Settings" }))
    const before = sentRequests(socket).length

    const options = within(await screen.findByRole("radiogroup", { name: "Window decoration" })).getAllByRole("radio")
    await user.click(options[1]!)
    await settle()

    expect(setWindowDecoration).toHaveBeenCalledWith("system")
    expect(sentRequests(socket).slice(before)).toEqual([])
  })
})

// What a tab sends on its own: on connect, once a project is open, and when a
// surface or a sheet tab mounts. The daemon refuses a method a credential may
// not send with the authentication error, before it reads the parameters
// (server.ts), and the client closes its connection on that code (client.ts).
// The fake socket here answers the same way, so a stray request shows as a
// closed socket as well as in the list of what was sent.
describe("requests a tab sends on its own", () => {
  const isControl = (method: RpcMethod) => rpcMethodAuthorizations[method] === "control"
  const handheldRefuses = (method: RpcMethod) => !phoneAndTabletRpcMethods.has(method)

  function refuseLikeTheDaemon(socket: FakeWebSocket, refuses: (method: RpcMethod) => boolean) {
    for (const request of sentRequests(socket)) {
      const method = request.method as RpcMethod
      if (socket.answered.has(request.id) || !refuses(method)) continue
      fail(socket, method, { code: daemonAuthenticationErrorCode, message: "Refused for this credential" })
    }
  }

  // The project is open on connect, then each sheet tab but Terminal (task 81
  // makes that tab watch-only on a handheld), then Settings, Skills and its
  // Tools tab, the audit log and Machines.
  async function walk(socket: FakeWebSocket, refuses: (method: RpcMethod) => boolean) {
    const user = userEvent.setup()
    const step = async () => {
      await settle()
      await act(async () => { refuseLikeTheDaemon(socket, refuses) })
      await settle()
    }
    await step()
    const sheet = screen.queryByRole("button", { name: "Open the sheet" })
    if (sheet) await user.click(sheet)
    await step()
    for (const name of ["Changes", "History", "Checkpoints", "Rules", "Preview"]) {
      const tab = screen.queryByRole("tab", { name })
      if (tab) await user.click(tab)
      await step()
    }
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await screen.findByRole("region", { name: "About this build" })
    await step()
    await user.click(await screen.findByRole("button", { name: /^Skills/u }))
    await screen.findByRole("heading", { level: 1, name: "Skills on this machine" })
    await step()
    await user.click(screen.getByRole("tab", { name: "Tools" }))
    await step()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Audit log/u }))
    await screen.findByRole("heading", { level: 1, name: "Audit log" })
    await step()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
    await screen.findByRole("heading", { level: 1, name: "Machines" })
    await step()
  }

  it.each(["phone", "tablet"] as const)("a %s tab with a project open sends nothing the daemon refuses it, and stays connected", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    expect(snapshot.project).toBeTruthy()
    const socket = await openWorkspace(snapshot, { clientKind })
    await walk(socket, handheldRefuses)

    expect(sentRequests(socket).map(({ method }) => method).filter((method) => handheldRefuses(method as RpcMethod))).toEqual([])
    // The composer still offers the project's skills by name, and the walk
    // reached the sheet, the Tools tab and the audit log.
    for (const method of ["skill.list", "session.history", "tool.inventory", "audit.query"] as const) {
      expect(sentRequests(socket, method), method).not.toHaveLength(0)
    }
    expect(harness.sockets).toHaveLength(1)
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it.each(["phone", "tablet"] as const)("a %s tab says why Settings shows no update status and no key status", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    await openWorkspace(snapshot, { clientKind })
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }))
    const about = await screen.findByRole("region", { name: "About this build" })
    await settle()

    expect(about.textContent).toContain("No update status: the daemon answers it only over loopback, to its owner's credential.")
    expect(screen.getByText(`Key status is off in a phone or tablet tab: the daemon does not report it to a phone or tablet credential. Use the desktop app on ${snapshot.machine.name}.`)).toBeTruthy()
    expect(screen.queryByText("Keychain unavailable")).toBeNull()
  })

  it.each(["web", "phone"] as const)("a watching %s tab sends nothing the daemon refuses it, and stays connected", async (clientKind) => {
    const snapshot = workspaceSnapshot({ clientAccess: "watching" } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind })
    const refuses = clientKind === "phone" ? (method: RpcMethod) => isControl(method) || handheldRefuses(method) : isControl
    await walk(socket, refuses)

    expect(sentRequests(socket).map(({ method }) => method).filter((method) => refuses(method as RpcMethod))).toEqual([])
    expect(harness.sockets).toHaveLength(1)
    expect(socket.readyState).toBe(socket.OPEN)
  })

  // A full-access web tab and the desktop keep every read: the skill
  // inventory once a project is open, and update and key status in Settings.
  it.each(["web", "desktop"] as const)("a %s tab still reads the skill inventory, update status and key status", async (clientKind) => {
    const socket = await openWorkspace(workspaceSnapshot(), { clientKind })
    await settle()
    expect(sentRequests(socket, "skill.inventory")).toHaveLength(1)

    const user = userEvent.setup()
    const skip = screen.queryByRole("button", { name: "Skip for now" })
    if (skip) { await user.click(skip); await settle() }
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await screen.findByRole("region", { name: "About this build" })
    await settle()

    expect(sentRequests(socket, "update.status")).toHaveLength(1)
    expect(sentRequests(socket, "provider.secret.list")).toHaveLength(1)
    expect(screen.queryByText(/Key status is off/u)).toBeNull()
  })
})
