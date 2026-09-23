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
  expect(section.textContent).toContain("~/Library/LaunchAgents/sh.domovoi.daemon.plist")
  expect(section.textContent).toContain("A LaunchAgent, for your user only.")
  expect(section.textContent).toContain("~/.domovoi/service.json")
  const install = within(section).getByRole("button", { name: "Install" })
  expect(install.hasAttribute("disabled")).toBe(true)
  expect(section.textContent).toContain("To finish by hand, run this in a terminal.")
  expect(within(section).getByText("domovoid service install")).toBeTruthy()
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(true)
})

it("draws the installed service as running, with what it wrote", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "service", platform: "linux" }} />)
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
  const install = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist" }))
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
  const remove = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist" }))
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "service", platform: "darwin", service: { install: vi.fn(), remove } }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(remove).toHaveBeenCalledOnce()
  expect(await within(section).findByText("Removed. Quitting Domovoi now stops the daemon and every session on it.")).toBeTruthy()
})
