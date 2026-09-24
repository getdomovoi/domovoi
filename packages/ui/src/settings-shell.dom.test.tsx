import type { ApprovalRule } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { defaultNotificationPreferences } from "./notification-preferences.js"
import { SettingsShell } from "./settings-shell.js"

afterEach(cleanup)

function shellProps() {
  return {
    providers: [],
    secrets: [],
    approvalRules: [] as readonly ApprovalRule[],
    notifications: defaultNotificationPreferences(),
    onNotificationsChange: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenFleet: vi.fn(),
    onOpenAudit: vi.fn(),
    theme: "system" as const,
    onThemeChange: vi.fn(),
  }
}

it("renders the v2 settings contract as one ordered scrolling column", () => {
  const { container } = render(<SettingsShell {...shellProps()} />)

  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy()
  expect(screen.getByText("This machine holds its own settings. Nothing here is synced anywhere unless the row says so.")).toBeTruthy()
  expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull()

  const content = container.textContent ?? ""
  const sections = ["Providers and tokens", "Notifications", "Permissions and rules", "Elsewhere", "Appearance"]
  const positions = sections.map((section) => content.indexOf(section))
  expect(positions.every((position) => position >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((left, right) => left - right))
})

it("adds External editor only where the client can change it", () => {
  render(
    <SettingsShell
      {...shellProps()}
      externalEditor="system"
      onExternalEditorChange={vi.fn()}
      windowDecoration="domovoi"
      activeWindowDecoration="domovoi"
      onWindowDecorationChange={vi.fn()}
    />,
  )

  expect(screen.getByRole("heading", { name: "External editor" })).toBeTruthy()
})

it("routes fleet and skills to the surfaces that own them", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await userEvent.click(screen.getByRole("button", { name: /Machines and daemons/u }))
  await userEvent.click(screen.getByRole("button", { name: /Skills/u }))

  expect(props.onOpenFleet).toHaveBeenCalledTimes(1)
  expect(props.onOpenSkills).toHaveBeenCalledTimes(1)
})

const activeRule: Extract<ApprovalRule, { status: "active" }> = {
  id: "rule-1",
  useCount: 0,
  projectId: "project-1",
  operation: "shell",
  command: "pnpm test",
  createdBy: "desktop",
  createdAt: "2026-09-03T10:00:00.000Z",
  status: "active",
  execution: {
    state: "resolved",
    digest: `sha256:${"a".repeat(64)}`,
    record: {
      version: 1,
      cwd: ".",
      kind: "shell",
      coverage: "command-and-script-text",
      entries: [{ id: 0, source: { kind: "request" }, parts: [{ operator: null, argv: ["pnpm", "test"], expandsTo: [] }] }],
    },
  },
}

const legacyRule: ApprovalRule = {
  id: "rule-2",
  useCount: 0,
  projectId: "project-1",
  operation: "shell",
  command: "pnpm build",
  createdBy: "web",
  createdAt: "2026-08-30T10:00:00.000Z",
  status: "inactive",
  inactiveReason: "legacy-text-only",
  inactivatedAt: "2026-09-03T09:00:00.000Z",
}

it("shows standing rules with the client that created them", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule]} />)

  const rules = within(screen.getByRole("list", { name: "Standing approval rules" }))
  const entry = within(rules.getAllByRole("listitem")[0]!)
  expect(entry.getByText("pnpm test")).toBeTruthy()
  expect(entry.getByText(/shell/u)).toBeTruthy()
  expect(entry.getByText(/desktop/u)).toBeTruthy()
})

it("says what a rule match does not cover", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule]} />)

  expect(screen.getByText(/Matches command and package-script text only/u)).toBeTruthy()
  expect(screen.getByText(/dependency binaries may still change/u)).toBeTruthy()
})

it("says a file-tool rule covers the worktree, not one path", async () => {
  const fileRule: ApprovalRule = {
    ...activeRule,
    id: "rule-3",
    command: "Edit",
    execution: {
      state: "resolved",
      digest: `sha256:${"b".repeat(64)}`,
      record: {
        version: 1,
        cwd: ".",
        kind: "workspace-file-tool",
        coverage: "tool-and-workspace-scope",
        tool: "Edit",
        scope: "workspace",
      },
    },
  }
  render(<SettingsShell {...shellProps()} approvalRules={[fileRule]} />)

  expect(screen.getByText(/matches that tool anywhere inside the worktree/u)).toBeTruthy()
  expect(screen.queryByText(/Matches command and package-script text only/u)).toBeNull()
})

it("announces a retired legacy rule before its approval card returns", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule, legacyRule]} />)

  const retired = within(screen.getByRole("list", { name: "Retired approval rules" }))
  const entry = within(retired.getAllByRole("listitem")[0]!)
  expect(entry.getByText("pnpm build")).toBeTruthy()
  expect(entry.getByText(/text only/u)).toBeTruthy()
  expect(entry.getByText(/needs explicit reapproval/u)).toBeTruthy()
  expect(within(screen.getByRole("list", { name: "Standing approval rules" })).queryByText("pnpm build")).toBeNull()
})

it("keeps a retired rule out of the active list even when it is the only rule", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[legacyRule]} />)

  expect(screen.getByText(/No standing rules/u)).toBeTruthy()
  expect(screen.getByRole("list", { name: "Retired approval rules" })).toBeTruthy()
})

it("states when a project has no standing rules", async () => {
  render(<SettingsShell {...shellProps()} />)

  expect(screen.getByText(/No standing rules/u)).toBeTruthy()
  expect(screen.queryByRole("list", { name: "Standing approval rules" })).toBeNull()
})

it("changes one notification kind without disturbing the others", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await userEvent.click(screen.getByRole("switch", { name: "Failures" }))

  expect(props.onNotificationsChange).toHaveBeenCalledWith({
    completion: true,
    failure: false,
    approvalNeeded: true,
  })
})

it("describes the local daemon on the machine pane when the client knows how it is served", () => {
  render(
    <SettingsShell
      {...shellProps()}
      localDaemon={{
        title: "Connected to the installed Domovoi service",
        detail: "The daemon runs outside this app and keeps running after it quits.",
      }}
    />,
  )

  const section = within(screen.getByRole("region", { name: /local daemon/iu }))
  expect(section.getByText("Connected to the installed Domovoi service")).toBeTruthy()
  expect(section.getByText("The daemon runs outside this app and keeps running after it quits.")).toBeTruthy()
})

it("draws no local daemon section for a client that cannot say how the daemon is served", () => {
  render(<SettingsShell {...shellProps()} />)

  expect(screen.queryByRole("region", { name: /local daemon/iu })).toBeNull()
  expect(screen.queryByText(/Domovoi service/u)).toBeNull()
})

// J24 (2026-09-23): Settings opens with the daemon on this machine and says
// what quitting does. Install and Remove are drawn locked until the app can
// do them; the by-hand command is beside the lock so nobody is left guessing.
it("draws the daemon section for a daemon inside this app, with Install locked and the command beside it", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Running Domovoi inside this app", detail: "This app started the local daemon and stops it when the app quits.", owner: "app", platform: "darwin" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("It owns every session here. This window and a paired phone are both its clients.")
  expect(section.textContent).toContain("Keep Domovoi running after I quit")
  expect(within(section).getByText("Off")).toBeTruthy()
  expect(section.textContent).toContain("Quitting Domovoi stops the daemon and every session on it.")
  expect(section.textContent).toContain("WHAT TURNING IT ON WRITES")
  expect(section.textContent).toContain("~/Library/LaunchAgents/sh.domovoi.domovoid.plist")
  expect(section.textContent).toContain("A LaunchAgent, for your user only.")
  expect(section.textContent).toContain("~/.domovoi/service.json")
  const install = within(section).getByRole("button", { name: "Install" })
  expect(install.hasAttribute("disabled")).toBe(true)
  expect(section.textContent).toContain("To finish by hand, run this in a terminal.")
  expect(within(section).getByText("domovoid service install")).toBeTruthy()
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(true)
})

it("draws the installed service as running, with what it wrote", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "outside", serviceInstalled: true, platform: "linux" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(within(section).getByText("Running")).toBeTruthy()
  expect(section.textContent).toContain("Quitting this app leaves the daemon and its sessions running.")
  expect(section.textContent).toContain("WHAT IT WROTE")
  expect(section.textContent).toContain("~/.config/systemd/user/domovoid.service")
  expect(section.textContent).toContain("systemd starts it again.")
  expect(section.textContent).toContain("Install is off: the service is already installed.")
  expect(within(section).getByRole("button", { name: "Stop, disable and delete the user unit" }).hasAttribute("disabled")).toBe(true)
  expect(within(section).getByText("domovoid service remove")).toBeTruthy()
})

// J24 handoff: when the desktop can install the service, Install is live,
// refuses while a turn runs or a gate waits (naming the sessions), reports
// the installer's own answer, and Remove is live once installed.
it("installs the login service when idle, and refuses by name while work is in flight", async () => {
  const user = userEvent.setup()
  const install = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", daemonRunning: true }))
  const daemon = { title: "Running Domovoi inside this app", detail: "", owner: "app" as const, platform: "darwin" as const }
  const { rerender } = render(<SettingsShell {...shellProps()} localDaemon={{ ...daemon, service: { install, remove: vi.fn(), refusal: "1 turn is running (Migrate billing webhooks) and 1 gate is waiting (Port the CLI auth flow)." } }} />)
  const section = () => screen.getByRole("region", { name: "Daemon on this machine" })
  expect(within(section()).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
  expect(section().textContent).toContain("The switch waits: 1 turn is running (Migrate billing webhooks) and 1 gate is waiting (Port the CLI auth flow). Nothing is interrupted.")
  expect(section().textContent).not.toContain("domovoid service install")
  rerender(<SettingsShell {...shellProps()} localDaemon={{ ...daemon, service: { install, remove: vi.fn() } }} />)
  await user.click(within(section()).getByRole("button", { name: "Install" }))
  expect(install).toHaveBeenCalledOnce()
  expect(await within(section()).findByText("Installed. Quitting this app now leaves the daemon and its sessions running.")).toBeTruthy()
  expect(section().textContent).toContain("/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist")
})

it("says what the installer refused, and that nothing changed", async () => {
  const user = userEvent.setup()
  const install = vi.fn(async () => ({ ok: false as const, reason: "runtime-missing" as const, part: "node" as const, path: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node", message: "The Node runtime this app ships was not found at /Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node. No service was installed and no service files were changed." }))
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app", platform: "darwin", service: { install, remove: vi.fn() } }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("Could not install the service")).toBeTruthy()
  expect(section.textContent).toContain("No service was installed and no service files were changed.")
  expect(section.textContent).toContain("To finish by hand, run this in a terminal.")
  expect(within(section).getByText("domovoid service install")).toBeTruthy()
})

it("removes the installed service and says the daemon is back inside this app", async () => {
  const user = userEvent.setup()
  const remove = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", profileRecovery: "not-needed" as const, daemonRunning: true }))
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, platform: "darwin", service: { install: vi.fn(), remove } }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(remove).toHaveBeenCalledOnce()
  expect(await within(section).findByText("Removed. Quitting Domovoi now stops the daemon and every session on it.")).toBeTruthy()
})

// Review round 1 of #576: Remove waits for the same work Install waits for,
// and each outcome the main process can report is drawn as what is still
// true. The lines were approved by fetzy on 2026-09-23.
function daemonSection(owner: "app" | "outside", service: { install?: () => Promise<unknown>; remove?: () => Promise<unknown>; refusal?: string }) {
  render(<SettingsShell {...shellProps()} localDaemon={{
    title: owner === "outside" ? "Connected to the installed Domovoi service" : "Running Domovoi inside this app", detail: "", owner, ...(owner === "outside" ? { serviceInstalled: true } : {}), platform: "darwin",
    service: { install: (service.install ?? vi.fn()) as never, remove: (service.remove ?? vi.fn()) as never, ...(service.refusal ? { refusal: service.refusal } : {}) },
  }} />)
  return screen.getByRole("region", { name: "Daemon on this machine" })
}

it("locks Remove while a turn runs or a gate waits, and names the work", () => {
  const section = daemonSection("outside", { refusal: "1 turn is running (Migrate billing webhooks)." })
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(true)
  expect(section.textContent).toContain("The switch waits: 1 turn is running (Migrate billing webhooks). Nothing is interrupted.")
})

it("draws the main process's own refusal, and a check that could not be read", async () => {
  const user = userEvent.setup()
  const remove = vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: "refused", message: "1 gate is waiting (Port the CLI auth flow)." })
    .mockResolvedValueOnce({ ok: false, reason: "check-failed", message: "connect ECONNREFUSED 127.0.0.1:47831" })
  const section = daemonSection("outside", { remove })
  const button = within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" })
  await user.click(button)
  expect(await within(section).findByText("The switch waits: 1 gate is waiting (Port the CLI auth flow). Nothing is interrupted.")).toBeTruthy()
  await user.click(button)
  expect(await within(section).findByText("Could not check for running turns or waiting gates, so the switch waits. Nothing is interrupted.")).toBeTruthy()
  expect(section.textContent).toContain("connect ECONNREFUSED 127.0.0.1:47831")
  expect(section.textContent).not.toContain("Could not remove the service")
})

it("says the service is installed when this window could not reach it", async () => {
  const user = userEvent.setup()
  const install = vi.fn(async () => ({ ok: false, reason: "installed-not-attached", kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", message: "The daemon did not answer" }))
  const section = daemonSection("app", { install })
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("Installed, but this window could not reach the daemon")).toBeTruthy()
  expect(section.textContent).toContain("The daemon did not answer")
  expect(section.textContent).toContain("The LaunchAgent is installed and the daemon inside this app is stopped. Whether the service started is not known from here.")
  expect(section.textContent).toContain("To check, run this in a terminal.")
  expect(within(section).getByText("domovoid service status")).toBeTruthy()
  expect(section.textContent).not.toContain("Nothing was installed.")
  expect(section.textContent).not.toContain("Could not install the service")
})

it("says the daemon is not running when a failed install could not start it again", async () => {
  const user = userEvent.setup()
  const install = vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped" })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl is not available", daemon: "untouched" })
  const section = daemonSection("app", { install })
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("Nothing was installed. The daemon inside this app stopped and did not start again, so no session is running. Quit and reopen Domovoi to start it.")).toBeTruthy()
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("Nothing was installed.")).toBeTruthy()
})

it("says the daemon is not running when a removal could not start it again", async () => {
  const user = userEvent.setup()
  const remove = vi.fn(async () => ({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", profileRecovery: "not-needed", daemonRunning: false }))
  const section = daemonSection("outside", { remove })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(await within(section).findByText("Removed. The daemon did not start again inside this app, so no session is running. Quit and reopen Domovoi to start it.")).toBeTruthy()
  expect(section.textContent).not.toContain("Removed. Quitting Domovoi now stops the daemon")
})

it("says what the person must do when the removal leaves the profile owner unresolved", async () => {
  const user = userEvent.setup()
  const remove = vi.fn()
    .mockResolvedValueOnce({ ok: true, kind: "file", target: "/p", profileRecovery: "operator-confirmation-required", daemonRunning: true })
    .mockResolvedValueOnce({ ok: true, kind: "file", target: "/p", profileRecovery: "proof-unavailable", profileRecoveryDetail: "The service record at ~/.domovoi/service.json could not be read", daemonRunning: true })
  const section = daemonSection("outside", { remove })
  const button = within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" })
  await user.click(button)
  expect(await within(section).findByText("Removed. The profile owner remains unresolved. After confirming no custom or legacy supervisor will restart it, run this in a terminal.")).toBeTruthy()
  expect(within(section).getByText("domovoid profile recover --confirm-no-supervisor")).toBeTruthy()
  await user.click(button)
  expect(await within(section).findByText("Removed. The service record at ~/.domovoi/service.json could not be read. No recovery receipt was written. Repair or inspect that file, then after confirming no custom or legacy supervisor will restart the daemon, run this in a terminal.")).toBeTruthy()
  expect(within(section).getByText("domovoid profile recover --confirm-no-supervisor")).toBeTruthy()
})

// The names come from the installer (packages/protocol login-service), not
// from the design's sample values.
it("names the Linux unit the installer writes and no lingering it does not turn on", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Running Domovoi inside this app", detail: "This app started the local daemon and stops it when the app quits.", owner: "app", platform: "linux" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("~/.config/systemd/user/domovoid.service")
  expect(section.textContent).not.toContain("Lingering")
  expect(section.textContent).not.toContain("loginctl")
})

// Native Windows runs the logon task unsupervised; only the WSL task has the
// crash supervisor, so nothing restarts a crashed daemon before the next sign-in.
it("names the Windows logon task the installer registers and says nothing restarts it", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "outside", serviceInstalled: true, platform: "win32" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain('Task Scheduler task "Domovoi daemon"')
  expect(section.textContent).toContain("Nothing restarts it until you next sign in.")
  expect(section.textContent).not.toContain("restarts it up to")
})

// A daemon this app did not start may be the service or a domovoid run by
// hand. Without a separate installed-service fact, Settings does not guess.
it("does not call a daemon this app did not start the installed service", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "outside", platform: "darwin" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(within(section).getByText("Not started here")).toBeTruthy()
  expect(section.textContent).toContain("A daemon this app did not start. Quitting this app leaves it running.")
  expect(section.textContent).not.toContain("WHAT IT WROTE")
  expect(section.textContent).not.toContain("WHAT TURNING IT ON WRITES")
  expect(section.textContent).not.toContain("Running")
  expect(section.textContent).toContain("This app cannot tell whether that daemon is the installed service. To check by hand, run this in a terminal.")
  expect(within(section).getByText("domovoid service status")).toBeTruthy()
  expect(section.textContent).toContain("Install and Remove are off: this app did not start that daemon.")
  expect(within(section).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
})

// Ruled 2026-09-23 (#577, B): after an app update the service can still run
// the runtime it was installed with. Settings names both versions.
it("says the login service runs an older Domovoi than this app", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, platform: "darwin", serviceVersion: "0.9.2", appVersion: "0.10.0" }} />)
  expect(screen.getByText("The login service runs Domovoi 0.9.2. This app is 0.10.0.")).toBeTruthy()
})

it("says nothing about versions when the service is current or newer", () => {
  const { rerender } = render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, platform: "darwin", serviceVersion: "0.10.0", appVersion: "0.10.0" }} />)
  expect(screen.queryByText(/The login service runs Domovoi/)).toBeNull()
  rerender(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, platform: "darwin", serviceVersion: "0.11.0", appVersion: "0.10.0" }} />)
  expect(screen.queryByText(/The login service runs Domovoi/)).toBeNull()
  rerender(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", platform: "darwin", serviceVersion: "0.9.2", appVersion: "0.10.0" }} />)
  expect(screen.queryByText(/The login service runs Domovoi/)).toBeNull()
})

// Ruled by fetzy 2026-09-23: when the recovery line and the not-running line
// both show, the second does not repeat "Removed.".
it("says Removed once when the profile owner is unresolved and the daemon did not start again", async () => {
  const user = userEvent.setup()
  const remove = vi.fn(async () => ({ ok: true, kind: "file", target: "/p", profileRecovery: "operator-confirmation-required", daemonRunning: false }))
  const section = daemonSection("outside", { remove })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(await within(section).findByText("Removed. The profile owner remains unresolved. After confirming no custom or legacy supervisor will restart it, run this in a terminal.")).toBeTruthy()
  expect(within(section).getByText("The daemon did not start again inside this app, so no session is running. Quit and reopen Domovoi to start it.")).toBeTruthy()
  expect(section.textContent?.match(/Removed\./g)).toHaveLength(1)
})

// Ruled 2026-09-23 (#577, B): "Update the service" moves the service to this
// app's runtime in place. Success adds no words; a failure shows only the
// daemon's own; an update this window cannot reach says so in its own words.
function olderService(update: () => Promise<unknown>, refusal?: string) {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, platform: "darwin", serviceVersion: "0.9.2", appVersion: "0.10.0", service: { install: vi.fn(), remove: vi.fn(), update: update as never, ...(refusal ? { refusal } : {}) } }} />)
  return screen.getByRole("region", { name: "Daemon on this machine" })
}

it("updates an older login service and then says nothing more", async () => {
  const user = userEvent.setup()
  const update = vi.fn(async () => ({ ok: true, kind: "file", target: "/p", daemonRunning: true }))
  const section = olderService(update)
  await user.click(within(section).getByRole("button", { name: "Update the service" }))
  expect(update).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(within(section).queryByText("The login service runs Domovoi 0.9.2. This app is 0.10.0.")).toBeNull())
  expect(within(section).queryByRole("button", { name: "Update the service" })).toBeNull()
  expect(within(section).queryByRole("alert")).toBeNull()
})

it("shows only the daemon's words when the update fails", async () => {
  const user = userEvent.setup()
  const words = "Domovoi could not update the service: launchctl print exited 113. Nothing was changed, and the service was left as it was."
  const section = olderService(vi.fn(async () => ({ ok: false, reason: "update-failed", message: words })))
  await user.click(within(section).getByRole("button", { name: "Update the service" }))
  const alert = await within(section).findByRole("alert")
  expect(alert.textContent).toBe(words)
})

it("says an update this window cannot reach was still made", async () => {
  const user = userEvent.setup()
  const section = olderService(vi.fn(async () => ({ ok: false, reason: "installed-not-attached", kind: "file", target: "/p", message: "The daemon did not answer" })))
  await user.click(within(section).getByRole("button", { name: "Update the service" }))
  const alert = await within(section).findByRole("alert")
  expect(alert.textContent).toBe("Updated, but this window could not reach the daemonThe daemon did not answer")
  expect(section.textContent).not.toContain("Installed, but this window could not reach the daemon")
})

it("keeps Update locked while a turn runs or a gate waits", () => {
  const section = olderService(vi.fn(), "1 gate is waiting (Fix login).")
  expect(within(section).getByRole("button", { name: "Update the service" }).hasAttribute("disabled")).toBe(true)
})
