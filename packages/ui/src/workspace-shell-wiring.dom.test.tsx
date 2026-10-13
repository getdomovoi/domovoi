import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { daemonAuthenticationErrorCode, phoneAndTabletRpcMethods, protocolVersion, rpcMethodAuthorizations, skillSummarySchema, type FleetMachine, type RpcMethod } from "@getdomovoi/protocol"

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

// Skills in a phone or tablet tab lists the catalog (skill.list), which the
// composer needs. Reading a SKILL.md, trusting, revoking, installing and the
// machine comparison use skill.read, skill.setEnabled, skill.review,
// skill.installPreview, skill.install and skill.inventory, none of which is
// on phoneAndTabletRpcMethods; the daemon answers each with the
// authentication error, on which the client closes its connection.
describe("Skills in a phone or tablet tab", () => {
  const listed = skillSummarySchema.parse({
    id: `skill-${"a".repeat(12)}`, name: "alpha", description: "alpha instructions", path: "/skills/alpha/SKILL.md",
    scope: "user", source: "agents", manifest: { version: 1, capabilities: ["filesystem.read"] },
    contentDigest: `sha256:${"a".repeat(64)}`, signature: { state: "unsigned" }, trust: { state: "untrusted", reason: "unsigned" },
  })

  async function openSkills(clientKind: "web" | "phone" | "tablet") {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    await act(async () => {
      respond(socket, "skill.list", [listed])
      const { id, name, platform, arch, version } = snapshot.machine
      if (clientKind === "web") respond(socket, "skill.inventory", { machine: { id, name, platform, arch, version }, skills: [] })
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /^Skills/u }))
    await screen.findByRole("heading", { level: 1, name: "Skills on this machine" })
    await settle()
    return { snapshot, socket, user }
  }

  it.each(["phone", "tablet"] as const)("a %s tab locks the skill actions, says why, and sends none of them", async (clientKind) => {
    const { snapshot, socket, user } = await openSkills(clientKind)
    const controls = [
      screen.getByRole("button", { name: /Install from a path/u }),
      screen.getByRole("button", { name: /View SKILL\.md/u }),
      screen.getByRole("button", { name: `Trust it for ${snapshot.project!.name}` }),
    ]
    for (const control of controls) {
      expect(control).toHaveProperty("disabled", true)
      await user.click(control)
    }
    await settle()

    expect(screen.getByText(`Install, Trust, Revoke and View SKILL.md are off in a phone or tablet tab: the daemon does not let a phone or tablet credential read or change a skill. Use the desktop app on ${snapshot.machine.name}.`)).toBeTruthy()
    // Under Inventories from your other machines and on the selected skill.
    expect(screen.getAllByText(`Machine comparison is off in a phone or tablet tab: the daemon does not report skill inventories to a phone or tablet credential. Use the desktop app on ${snapshot.machine.name}.`)).toHaveLength(2)
    expect(screen.queryByText("Unknown until this machine inventory is fetched.")).toBeNull()
    expect(screen.queryByText("No other paired machine reports the skills capability.")).toBeNull()
    for (const method of ["skill.read", "skill.setEnabled", "skill.review", "skill.installPreview", "skill.install", "skill.inventory"] as const) {
      expect(sentRequests(socket, method), method).toEqual([])
    }
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it("a web tab keeps them", async () => {
    await openSkills("web")
    expect(screen.getByRole("button", { name: /Install from a path/u })).toHaveProperty("disabled", false)
    expect(screen.getByRole("button", { name: /View SKILL\.md/u })).toHaveProperty("disabled", false)
    expect(screen.queryByText(/are off in a phone or tablet tab/u)).toBeNull()
  })
})

// Controls a person presses whose request is not on phoneAndTabletRpcMethods:
// Take a checkpoint (checkpoint.create), Revert, Reset and Restore worktree
// (checkpoint.restore), a file's Revert (session.revertFile), Revoke
// (approvalRule.revoke), Archive session (session.archive), Export this query
// (audit.export), the provider's Try again (session.restartProviderThread) and
// settling a move (session.transferResolveConflict). The daemon answers each
// from a phone or tablet credential with the authentication error, before it
// reads the parameters (server.ts), and the client closes its connection on
// that code (client.ts). A phone or tablet tab locks them and says why; the
// fake socket refuses the way the daemon does, so a stray press shows as a
// closed socket as well as in the list of what was sent.
describe("controls a phone or tablet tab presses", () => {
  const handheldRefuses = (method: RpcMethod) => !phoneAndTabletRpcMethods.has(method)
  const pressed = [
    "checkpoint.create", "checkpoint.restore", "session.revertFile", "approvalRule.revoke", "session.archive",
    "audit.export", "session.restartProviderThread", "session.transferResolveConflict", "session.transferRecoverSource",
  ] as const satisfies readonly RpcMethod[]
  const off = (controls: string, refused: string, machine: string) =>
    `${controls} off in a phone or tablet tab: the daemon does not ${refused} for a phone or tablet credential. Use the desktop app on ${machine}.`

  it("names only methods the daemon refuses a phone or tablet credential", () => {
    for (const method of pressed) expect(phoneAndTabletRpcMethods.has(method), method).toBe(false)
  })

  function withRule(): Hello {
    const base = workspaceSnapshot()
    return workspaceSnapshot({
      approvalRules: [{
        id: "rule-tests", useCount: 4, projectId: base.project!.id, operation: "shell", command: "pnpm test",
        createdBy: "desktop", createdAt: "2026-09-03T10:00:00.000Z", status: "active",
        execution: {
          state: "resolved", digest: `sha256:${"a".repeat(64)}`,
          record: { version: 1, cwd: ".", kind: "shell", coverage: "command-and-script-text", entries: [{ id: 0, source: { kind: "request" }, parts: [{ operator: null, argv: ["pnpm", "test"], expandsTo: [] }] }] },
        },
      }],
    } as Partial<Hello>)
  }

  // The daemon pages history oldest first: the session start, then a manual one.
  const historyPage = (sessionId: string) => ({
    sessionId,
    hasMore: false,
    items: [
      { id: "thread:ckpt-0000", sourceId: "ckpt-0000", sessionId, createdAt: "2026-09-08T14:02:00.000Z", category: "checkpoints" as const, reason: "session-start" as const, label: "Worktree created off main", commit: "b".repeat(40) },
      { id: "thread:ckpt-7f24", sourceId: "ckpt-7f24", sessionId, createdAt: "2026-09-08T14:06:00.000Z", category: "checkpoints" as const, reason: "manual" as const, label: "Before the migration ran", commit: "a".repeat(40) },
    ],
  })
  const evidence = (sessionId: string) => ({
    sessionId,
    refreshedAt: "2026-09-01T12:00:00.000Z",
    workspace: {
      baseCommit: "a".repeat(40),
      diff: "",
      diffTruncated: false,
      totalChangedFiles: 1,
      files: [{ path: "src/app.ts", status: "modified" as const, staged: false, unstaged: true, additions: 1, deletions: 1, binary: false }],
      filesTruncated: false,
    },
    tests: { passed: 0, failed: 0, totalRuns: 0, runs: [], runsTruncated: false },
  })

  // Answers the reads the sheet tabs make, and refuses anything a phone or
  // tablet credential may not send the way the daemon does.
  function answer(socket: FakeWebSocket, refuses: (method: RpcMethod) => boolean) {
    for (const request of sentRequests(socket)) {
      if (socket.answered.has(request.id)) continue
      const method = request.method as RpcMethod
      const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId ?? ""
      if (refuses(method)) fail(socket, method, { code: daemonAuthenticationErrorCode, message: "Refused for this credential" })
      else if (method === "session.history") { socket.answered.add(request.id); socket.receive({ jsonrpc: "2.0", id: request.id, result: historyPage(sessionId) }) }
      else if (method === "session.evidence") { socket.answered.add(request.id); socket.receive({ jsonrpc: "2.0", id: request.id, result: evidence(sessionId) }) }
    }
  }

  async function openTab(socket: FakeWebSocket, refuses: (method: RpcMethod) => boolean, name: string) {
    const user = userEvent.setup()
    const sheet = screen.queryByRole("button", { name: "Open the sheet" })
    if (sheet) await user.click(sheet)
    await user.click(screen.getByRole("tab", { name }))
    await settle()
    await act(async () => { answer(socket, refuses) })
    await settle()
    return user
  }

  async function pressAll(user: ReturnType<typeof userEvent.setup>, controls: readonly HTMLElement[]) {
    for (const control of controls) {
      expect(control).toHaveProperty("disabled", true)
      await user.click(control)
    }
    await settle()
  }

  function expectNothingRefused(socket: FakeWebSocket) {
    expect(sentRequests(socket).map(({ method }) => method).filter((method) => handheldRefuses(method as RpcMethod))).toEqual([])
    expect(harness.sockets).toHaveLength(1)
    expect(socket.readyState).toBe(socket.OPEN)
  }

  it.each(["phone", "tablet"] as const)("a %s tab locks Take a checkpoint, Revert and Reset, says why, and keeps Fork", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = await openTab(socket, handheldRefuses, "Checkpoints")
    const panel = await screen.findByTestId("checkpoints-content")
    await within(panel).findByRole("button", { name: "Reset" })

    await pressAll(user, [
      within(panel).getByRole("button", { name: /Take a checkpoint/u }),
      within(panel).getByRole("button", { name: "Revert" }),
      within(panel).getByRole("button", { name: "Reset" }),
    ])
    await act(async () => { answer(socket, handheldRefuses) })

    expect(within(panel).getByText(off("Take a checkpoint, Revert and Reset are", "take or restore a checkpoint", snapshot.machine.name))).toBeTruthy()
    expect(within(panel).getByRole("button", { name: "Fork" })).toHaveProperty("disabled", false)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab locks History's Restore worktree and says why", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openTab(await openWorkspace(snapshot, { clientKind }), handheldRefuses, "History").then(() => harness.socket(0))
    const panel = await screen.findByTestId("history-content")
    const restores = await within(panel).findAllByRole("button", { name: "Restore worktree" })
    expect(restores).toHaveLength(2)

    await pressAll(userEvent.setup(), restores)
    await act(async () => { answer(socket, handheldRefuses) })

    expect(within(panel).getByText(off("Restore worktree is", "restore a checkpoint", snapshot.machine.name))).toBeTruthy()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab offers no Restore worktree on the thread's checkpoint", async (clientKind) => {
    const socket = await openWorkspace(workspaceSnapshot(), { clientKind })
    expect(screen.getByText(/^Checkpoint · ckpt_7f21/u)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Restore worktree" })).toBeNull()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab refuses /revert with the reason and sends no restore", async (clientKind) => {
    const snapshot = workspaceSnapshot({ approvals: [] } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Message"), "/revert thread-checkpoint{Enter}")
    await settle()
    await act(async () => { answer(socket, handheldRefuses) })

    expect(await screen.findByText(off("Restoring a checkpoint is", "restore a checkpoint", snapshot.machine.name))).toBeTruthy()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab offers no file Revert in Changes and says why", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    await openTab(socket, handheldRefuses, "Changes")
    await screen.findByText("src/app.ts")

    expect(screen.queryByRole("button", { name: "Revert src/app.ts" })).toBeNull()
    expect(screen.getByText(off("Reverting a file is", "revert a file", snapshot.machine.name))).toBeTruthy()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab locks Revoke in Rules and says why", async (clientKind) => {
    const snapshot = withRule()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = await openTab(socket, handheldRefuses, "Rules")
    const row = screen.getAllByTestId("rule-row")[0]!

    await pressAll(user, [within(row).getByRole("button", { name: "Revoke" })])
    await act(async () => { answer(socket, handheldRefuses) })

    expect(screen.getByText(off("Revoke is", "revoke a rule", snapshot.machine.name))).toBeTruthy()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab locks a session's Archive session and says why", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^Sessions \d/u }))
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    await user.click(screen.getByRole("button", { name: `Actions for ${active.title}` }))
    const archive = await screen.findByRole("menuitem", { name: "Archive session" })

    expect(archive.getAttribute("aria-disabled")).toBe("true")
    await user.click(archive)
    await settle()
    await act(async () => { answer(socket, handheldRefuses) })

    expect(screen.getByText(off("Archive session is", "archive a session", snapshot.machine.name))).toBeTruthy()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab's command palette offers no Take a checkpoint", async (clientKind) => {
    const socket = await openWorkspace(workspaceSnapshot(), { clientKind })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Open command palette" }))
    await screen.findByRole("option", { name: /Open the changes sheet/u })

    expect(screen.queryByRole("option", { name: /Take a checkpoint/u })).toBeNull()
    expectNothingRefused(socket)
  })

  it.each(["phone", "tablet"] as const)("a %s tab locks the audit log's Export this query and says why", async (clientKind) => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot, { clientKind })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Audit log/u }))
    await screen.findByRole("heading", { level: 1, name: "Audit log" })

    await pressAll(user, [screen.getByRole("button", { name: "Export this query" })])
    await act(async () => { answer(socket, handheldRefuses) })

    expect(screen.getByText(off("Export this query is", "export the audit log", snapshot.machine.name))).toBeTruthy()
    expectNothingRefused(socket)
  })

  // A provider that stopped answering leaves the session failed with no
  // provider thread; Try again restarts it with session.restartProviderThread.
  it.each(["phone", "tablet"] as const)("a %s tab locks the provider's Try again and says why", async (clientKind) => {
    const base = workspaceSnapshot()
    const snapshot = workspaceSnapshot({
      approvals: [],
      sessions: base.sessions.map((session) => session.id === base.activeSessionId
        ? (({ providerThreadId: _thread, activeTurnId: _turn, ...rest }) => ({ ...rest, state: "failed" as const }))(session)
        : session),
    } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind })

    await pressAll(userEvent.setup(), [screen.getByRole("button", { name: "Try again" })])
    await act(async () => { answer(socket, handheldRefuses) })

    expect(screen.getByText(off("Try again is", "restart a provider", snapshot.machine.name))).toBeTruthy()
    expectNothingRefused(socket)
  })

  // Another machine also claims the session; settling it sends
  // session.transferResolveConflict.
  it.each(["phone", "tablet"] as const)("a %s tab locks Settle this on a contested session and says why", async (clientKind) => {
    const base = workspaceSnapshot()
    const snapshot = workspaceSnapshot({
      approvals: [],
      sessions: base.sessions.map((session) => session.id === base.activeSessionId
        ? (({ activeTurnId: _turn, providerThreadId: _thread, ...rest }) => ({
          ...rest,
          state: "ownership-conflict" as const,
          workspacePath: "/worktrees/session",
          ownershipGeneration: 3,
          ownershipConflict: {
            kind: "target-session-detected" as const, transferId: `transfer-${"a".repeat(32)}`, otherMachineId: `machine-${"b".repeat(32)}`,
            otherGeneration: 4, detectedAt: "2026-09-04T11:00:00.000Z", recoveryAction: "keep-target-session" as const,
            reason: "target-session-newer" as const, manifestDigest: `sha256:${"f".repeat(64)}`,
          },
        }))(session)
        : session),
    } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind })

    await pressAll(userEvent.setup(), [screen.getByRole("button", { name: "Settle this" })])
    await act(async () => { answer(socket, handheldRefuses) })

    expect(screen.getByText(off("Settle this is", "settle a move", snapshot.machine.name))).toBeTruthy()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expectNothingRefused(socket)
  })

  // The desktop app and a full-access web tab keep every one of them.
  it.each(["desktop", "web"] as const)("a %s tab keeps them live with no reason line", async (clientKind) => {
    const socket = await openWorkspace(withRule(), { clientKind })
    const user = userEvent.setup()
    const skip = screen.queryByRole("button", { name: "Skip for now" })
    if (skip) { await user.click(skip); await settle() }
    expect(screen.getByRole("button", { name: "Restore worktree" })).toHaveProperty("disabled", false)

    await openTab(socket, () => false, "Checkpoints")
    const checkpoints = await screen.findByTestId("checkpoints-content")
    await within(checkpoints).findByRole("button", { name: "Reset" })
    for (const name of [/Take a checkpoint/u, /^Revert$/u, /^Reset$/u]) {
      expect(within(checkpoints).getByRole("button", { name })).toHaveProperty("disabled", false)
    }
    await openTab(socket, () => false, "Changes")
    expect(await screen.findByRole("button", { name: "Revert src/app.ts" })).toBeTruthy()
    await openTab(socket, () => false, "Rules")
    expect(within(screen.getAllByTestId("rule-row")[0]!).getByRole("button", { name: "Revoke" })).toHaveProperty("disabled", false)
    await user.click(within(screen.getAllByTestId("rule-row")[0]!).getByRole("button", { name: "Revoke" }))
    await settle()
    expect(sentRequests(socket, "approvalRule.revoke")).toHaveLength(1)

    expect(screen.queryByText(/off in a phone or tablet tab/u)).toBeNull()
  })
})
