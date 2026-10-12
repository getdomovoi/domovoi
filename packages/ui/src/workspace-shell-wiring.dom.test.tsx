import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { terminalIdForSession } from "./terminal-id"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
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
