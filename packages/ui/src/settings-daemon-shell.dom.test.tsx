import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
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

// Review round 3 of #576: an install the desktop answered in a shape this
// window cannot read still ends with the service read back, both in the
// outcome and in the section's own state.
it("reads the service back through the desktop when the install answer cannot be read", async () => {
  const install = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
  const windowBridge = bridge(install as never)
  const status = vi.fn()
    .mockResolvedValueOnce({ installed: false, running: false, detail: "" })
    .mockResolvedValue({ installed: true, running: false, detail: "not loaded" })
  windowBridge.daemonService!.status = status
  const idle = workspaceSnapshot({ approvals: [], sessions: demoWorkspace.sessions.map((session) => { const { activeTurnId: _turn, ...rest } = session; return { ...rest, state: "idle" as const } }) })
  render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} />)
  await act(async () => { completeHandshake(harness.socket(0), idle) })
  await settle()
  const user = userEvent.setup()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  const section = await screen.findByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("The LaunchAgent is installed but not running.")).toBeTruthy()
  expect(section.textContent).not.toContain("Nothing changed.")
  // Once for the section, once for the outcome, once more to refresh the
  // section after the failed call.
  await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
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

// Security review round 4 of #576. Two orderings the shell must survive: a
// reply this window cannot read after the desktop did change the service, and
// a status read that answers after a newer one.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
type Status = { installed: boolean | null; running: boolean; detail: string }
const quietWorkspace = () => workspaceSnapshot({ approvals: [], sessions: demoWorkspace.sessions.map((session) => { const { activeTurnId: _turn, ...rest } = session; return { ...rest, state: "idle" as const } }) })
type LocalDaemon = { title: string; detail: string; owner: "app" | "outside"; serviceInstalled?: boolean }
const inApp: LocalDaemon = { title: "Running Domovoi inside this app", detail: "", owner: "app" }
const outside: LocalDaemon = { title: "Connected to a daemon outside this app", detail: "", owner: "outside" }

async function openDaemonSection(windowBridge: DesktopWindowBridge, localDaemon: LocalDaemon, onLocalDaemonChanged = vi.fn()) {
  const view = render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={localDaemon} onLocalDaemonChanged={onLocalDaemonChanged} />)
  await act(async () => { completeHandshake(harness.socket(0), quietWorkspace()) })
  await settle()
  const user = userEvent.setup()
  await skipFirstRun(user)
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("region", { name: "Daemon on this machine" })
  const section = () => screen.getByRole("region", { name: "Daemon on this machine" })
  // What the desktop does when told the daemon changed: it resolves its
  // daemon again and hands the shell the new owner.
  const moveTo = (next: LocalDaemon) => view.rerender(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={next} onLocalDaemonChanged={onLocalDaemonChanged} />)
  return { user, section, moveTo }
}

it("refreshes the daemon owner when an unreadable reply follows a change the read-back confirms", async () => {
  for (const [action, button, after, changed] of [
    ["install", "Install", { installed: true, running: true, detail: "" }, true],
    ["install", "Install", { installed: false, running: false, detail: "" }, false],
    ["remove", "Unload and delete the LaunchAgent", { installed: false, running: false, detail: "" }, true],
    ["remove", "Unload and delete the LaunchAgent", { installed: true, running: true, detail: "" }, false],
  ] as const) {
    const windowBridge = bridge(vi.fn())
    const unreadable = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
    windowBridge.daemonService!.install = unreadable
    windowBridge.daemonService!.remove = unreadable
    const before: Status = action === "install" ? { installed: false, running: false, detail: "" } : { installed: true, running: true, detail: "" }
    windowBridge.daemonService!.status = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after)
    const onLocalDaemonChanged = vi.fn()
    const { user, section } = await openDaemonSection(windowBridge, action === "install" ? inApp : outside, onLocalDaemonChanged)
    await user.click(within(section()).getByRole("button", { name: button }))
    // Ruled 2026-09-25: after a change the read-back confirms, the header
    // does not say the change failed.
    const header = changed
      ? (action === "install" ? "Could not confirm the install" : "Could not confirm the removal")
      : (action === "install" ? "Could not install the service" : "Could not remove the service")
    expect(await within(section()).findByText(header)).toBeTruthy()
    expect(onLocalDaemonChanged).toHaveBeenCalledTimes(changed ? 1 : 0)
    cleanup()
    harness.uninstall()
    harness = installFakeWebSocket()
  }
})

it("keeps the newer status when a read started before an install answers after it", async () => {
  const stale = deferred<Status>()
  const windowBridge = bridge(vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/p", daemonRunning: true })))
  windowBridge.daemonService!.status = vi.fn()
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValue({ installed: true, running: true, detail: "pid 48213" })
  const { user, section, moveTo } = await openDaemonSection(windowBridge, inApp)
  await user.click(within(section()).getByRole("button", { name: "Install" }))
  expect(await within(section()).findByText("Installed. Quitting this app now leaves the daemon and its sessions running.")).toBeTruthy()
  moveTo(outside)
  await act(async () => { stale.resolve({ installed: false, running: false, detail: "" }) })
  await settle()
  expect(within(section()).getByText("Running")).toBeTruthy()
  expect(within(section()).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(false)
})

it("keeps the newer status when a read started before a removal answers after it", async () => {
  const stale = deferred<Status>()
  const windowBridge = bridge(vi.fn())
  windowBridge.daemonService!.remove = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/p", profileRecovery: "not-needed" as const, daemonRunning: true, daemonAttached: true }))
  windowBridge.daemonService!.status = vi.fn()
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValue({ installed: false, running: false, detail: "" })
  const { user, section, moveTo } = await openDaemonSection(windowBridge, { ...outside, serviceInstalled: true })
  await user.click(within(section()).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  await within(section()).findByText(/This app is connected to a daemon it did not start/)
  moveTo(outside)
  await act(async () => { stale.resolve({ installed: true, running: true, detail: "pid 48213" }) })
  await settle()
  expect(within(section()).getByText("Not started here")).toBeTruthy()
  expect(within(section()).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(true)
})

it("keeps the newer status when a read started before an unreadable reply answers after the re-read", async () => {
  const stale = deferred<Status>()
  const windowBridge = bridge(vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") }) as never)
  windowBridge.daemonService!.status = vi.fn()
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValue({ installed: true, running: true, detail: "pid 48213" })
  const { user, section, moveTo } = await openDaemonSection(windowBridge, inApp)
  await user.click(within(section()).getByRole("button", { name: "Install" }))
  expect(await within(section()).findByText("The LaunchAgent is installed and running.")).toBeTruthy()
  moveTo(outside)
  await act(async () => { stale.resolve({ installed: false, running: false, detail: "" }) })
  await settle()
  expect(within(section()).getByText("Running")).toBeTruthy()
  expect(within(section()).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(false)
})

// Security review round 5 of #576. A readable failure can still change who
// holds the daemon: the app's daemon started again, this app attached to one
// it did not start, or the service was left written or partly removed. Each
// failed shape is walked; after the desktop resolves its daemon again, the
// section's owner facts (the toggle, its quit line, whether Remove is live)
// must match what the failure reported. The desktop here resolves as the real
// one does: its own daemon back, attached to the service, unchanged, or, after
// a stop, attached to a running service or starting its own.
type FailureRead = { installed: boolean | null; running: boolean } | null
const failureCases = (["install", "remove"] as const).flatMap((action) =>
  ([{ installed: true, running: true }, { installed: true, running: false }, { installed: false, running: false }, null] as FailureRead[]).flatMap((service) =>
    (["restarted", "attached", "stopped", "untouched"] as const).map((daemon) => ({ action, service, daemon }))))

// One test per shape, so each stays within the default time on a loaded box.
it.each(failureCases)("refreshes the owner after a failed $action (read-back $service, daemon $daemon) only when it moved, and draws what is now true", async ({ action, service, daemon }) => {
  const before: LocalDaemon = action === "install" ? inApp : outside
  const confirmedChange = service !== null && service.installed !== null
    && (action === "install" ? service.installed : !(service.installed && service.running))
  const refreshes = daemon === "restarted" || daemon === "attached" || confirmedChange
  const resolved: LocalDaemon = daemon === "restarted" ? inApp
    : daemon === "attached" ? outside
      : daemon === "untouched" ? before
        : service?.running ? outside : inApp
  const ownerAfter = refreshes ? resolved : before
  const windowBridge = bridge(vi.fn())
  const failure = { ok: false as const, reason: "failed" as const, message: "launchctl exited 5", daemon, service }
  windowBridge.daemonService!.install = vi.fn(async () => failure)
  windowBridge.daemonService!.remove = vi.fn(async () => failure)
  windowBridge.daemonService!.status = vi.fn()
    .mockResolvedValueOnce(action === "install" ? { installed: false, running: false, detail: "" } : { installed: true, running: true, detail: "" })
    .mockResolvedValue(service ? { ...service, detail: "" } : { unavailable: "launchctl could not be run" })
  let moveTo: (next: LocalDaemon) => void = () => {}
  const onLocalDaemonChanged = vi.fn(() => moveTo(resolved))
  const opened = await openDaemonSection(windowBridge, before, onLocalDaemonChanged)
  moveTo = opened.moveTo
  await opened.user.click(within(opened.section()).getByRole("button", { name: action === "install" ? "Install" : "Unload and delete the LaunchAgent" }))
  await within(opened.section()).findByText(action === "install" ? "Could not install the service" : "Could not remove the service")
  await settle()
  expect(onLocalDaemonChanged).toHaveBeenCalledTimes(refreshes ? 1 : 0)
  const section = opened.section()
  // Security review round 9: the service is drawn as Running, with the
  // manager restarting it after a crash, only while the service itself runs.
  // A daemon outside the app answering is not proof of that.
  const running = ownerAfter.owner === "outside" && service?.installed === true && service.running
  const toggle = ownerAfter.owner === "app" ? "Off" : running ? "Running" : "Not started here"
  const quitLine = ownerAfter.owner === "app"
    ? "Quitting Domovoi stops the daemon and every session on it."
    : running ? "Quitting this app leaves the daemon and its sessions running." : "A daemon this app did not start. Quitting this app leaves it running."
  expect(within(section).getByText(toggle)).toBeTruthy()
  expect(section.textContent).toContain(quitLine)
  // Security review round 8: whether the service is installed is its own
  // fact, taken from the read-back, not from who holds the daemon. Remove is
  // live whenever the service reads back installed, and nothing says nothing
  // is installed then. (This walk first tied Remove to the owner as well, so
  // it expected the bug.)
  expect(section.textContent?.includes("launchd starts it again.")).toBe(running)
  const installed = service?.installed === true
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(!installed)
  if (installed) {
    expect(section.textContent).toContain("Install is off: the service is already installed.")
    expect(section.textContent).not.toContain("nothing is installed")
    expect(within(section).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
  }
})
