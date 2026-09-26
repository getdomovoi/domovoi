import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })
// A desktop with a bridge opens first-run setup over the shell; this test is
// about Settings, so it skips the setup the way a person would.
async function skipFirstRun(user: ReturnType<typeof userEvent.setup>) {
  const skip = screen.queryByRole("button", { name: "Skip for now" })
  if (skip) { await user.click(skip); await settle() }
}
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// Without an install, the bridge offers no login service, as a desktop that
// ships no daemon runtime does.
function bridge(install?: () => Promise<{ ok: true; kind: "file"; target: string; daemonRunning: boolean }>, platform: DesktopWindowBridge["platform"] = "darwin"): DesktopWindowBridge {
  return {
    platform,
    getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
    captureAnnotation: async () => { throw new Error("not in this test") },
    notify: async () => true,
    onNotificationActivate: () => () => {},
    openDirectory: async () => ({ status: "cancelled" as const }),
    readClipboardText: async () => "",
    writeClipboardText: async () => true,
    openExternal: async () => true,
    onDeepLink: () => () => {},
    getWindowDecoration: async () => "system",
    setWindowDecoration: async () => true,
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    ...(install ? { daemonService: { status: async () => ({ installed: false, running: false, detail: "" }), install, remove: async () => ({ ok: true as const, kind: "file" as const, target: "/p", daemonRunning: true }) } } : {}),
  }
}

// J24: the shell refuses the handoff by name from its own snapshot, and once
// the installer answers, tells the desktop so it resolves its daemon again.
it("refuses while a turn runs, then installs and reports the change", async () => {
  const install = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", daemonRunning: true }))
  const onLocalDaemonChanged = vi.fn()
  const running = workspaceSnapshot()
  render(<WorkspaceShell clientKind="desktop" windowBridge={bridge(install)} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} onLocalDaemonChanged={onLocalDaemonChanged} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, running) })
  await settle()
  const user = userEvent.setup()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  // Settings loads on first open, so wait for the section rather than a tick.
  await screen.findByRole("region", { name: "Daemon on this machine" })
  const section = () => screen.getByRole("region", { name: "Daemon on this machine" })
  const gated = running.sessions.find((session) => session.id === running.approvals[0]?.sessionId)
  expect(section().textContent).toContain(`The switch waits: 1 gate is waiting (${gated?.title}). Nothing is interrupted.`)
  expect(within(section()).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
})

it("installs when idle and tells the desktop the daemon changed", async () => {
  const install = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", daemonRunning: true }))
  const onLocalDaemonChanged = vi.fn()
  const section = () => screen.getByRole("region", { name: "Daemon on this machine" })
  const user = userEvent.setup()
  const idle = workspaceSnapshot({ approvals: [], sessions: demoWorkspace.sessions.map((session) => { const { activeTurnId: _turn, ...rest } = session; return { ...rest, state: "idle" as const } }) })
  render(<WorkspaceShell clientKind="desktop" windowBridge={bridge(install)} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} onLocalDaemonChanged={onLocalDaemonChanged} />)
  const quiet = harness.socket(0)
  await act(async () => { completeHandshake(quiet, idle) })
  await settle()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  // Settings loads on first open, so wait for the section rather than a tick.
  await screen.findByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section()).getByRole("button", { name: "Install" }))
  await settle()
  expect(install).toHaveBeenCalledOnce()
  expect(onLocalDaemonChanged).toHaveBeenCalledOnce()
  expect(await within(section()).findByText("Installed. Quitting this app now leaves the daemon and its sessions running.")).toBeTruthy()
})

// The installed-service fact the daemon section waits for comes from the
// desktop's own status read, so a daemon outside the app is drawn as the
// service, with Remove live, only when the service manager says it is there.
it("draws a daemon outside the app as the service once the desktop reports the service installed", async () => {
  const install = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/p", daemonRunning: true }))
  const windowBridge = bridge(install)
  windowBridge.daemonService!.status = vi.fn(async () => ({ installed: true, running: true, detail: "pid 48213" }))
  const idle = workspaceSnapshot({ approvals: [], sessions: demoWorkspace.sessions.map((session) => { const { activeTurnId: _turn, ...rest } = session; return { ...rest, state: "idle" as const } }) })
  render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={{ title: "Connected to a daemon outside this app", detail: "", owner: "outside" }} />)
  await act(async () => { completeHandshake(harness.socket(0), idle) })
  await settle()
  const user = userEvent.setup()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  const section = await screen.findByRole("region", { name: "Daemon on this machine" })
  expect(within(section).getByText("Running")).toBeTruthy()
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(false)
})

it("keeps a daemon outside the app unnamed when the service status cannot be read", async () => {
  const windowBridge = bridge(vi.fn())
  windowBridge.daemonService!.status = vi.fn(async () => ({ unavailable: "launchctl could not be run" }))
  render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={{ title: "Connected to a daemon outside this app", detail: "", owner: "outside" }} />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
  const user = userEvent.setup()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  const section = await screen.findByRole("region", { name: "Daemon on this machine" })
  expect(within(section).getByText("Not started here")).toBeTruthy()
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(true)
})

// J24: the desktop's daemon copy names the owner but not the platform; the
// shell takes the platform from the window bridge, so Settings can name the
// service this machine's installer writes.
it("draws the daemon section with the window's platform", async () => {
  const localDaemon = { title: "Running Domovoi inside this app", detail: "This app started the local daemon and stops it when the app quits.", owner: "app" as const }
  render(<WorkspaceShell windowBridge={bridge(undefined, "linux")} localDaemon={localDaemon} />)
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }))
  const section = await screen.findByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("~/.config/systemd/user/domovoid.service")
  expect(screen.queryByRole("region", { name: /local daemon/iu })).toBeNull()
})
