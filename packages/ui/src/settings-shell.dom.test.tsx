import type { ApprovalRule } from "@getdomovoi/protocol"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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

it("says a worktree-wide file-tool rule no longer matches", async () => {
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

  expect(screen.getByText(/made for the whole worktree no longer matches anything/u)).toBeTruthy()
  expect(screen.queryByText(/Matches command and package-script text only/u)).toBeNull()
})

it("says a file-tool rule covers one file", async () => {
  const fileRule: ApprovalRule = {
    ...activeRule,
    id: "rule-4",
    command: "Edit",
    execution: {
      state: "resolved",
      digest: `sha256:${"c".repeat(64)}`,
      record: {
        version: 1,
        cwd: ".",
        kind: "workspace-file-tool",
        coverage: "tool-and-file",
        tool: "Edit",
        scope: "file",
        path: "src/index.ts",
      },
    },
  }
  render(<SettingsShell {...shellProps()} approvalRules={[fileRule]} />)

  expect(screen.getByText(/matches that tool on one file/u)).toBeTruthy()
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

// J10 (2026-09-23): the build says what it is. Unsigned, no self-update,
// versions come from the release page; the daemon's version and commit in mono.
it("says the build is not signed and where new versions come from", async () => {
  const onOpenReleasePage = vi.fn(async () => true)
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", currentSourceCommit: "3f8b01d".padEnd(40, "0"), state: "idle" as const })), onOpenReleasePage }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  expect(await within(section).findByText("domovoid 0.9.4 · 3f8b01d")).toBeTruthy()
  expect(within(section).getByText("Not signed")).toBeTruthy()
  expect(within(section).getByText("This build is not signed and does not update itself. Get new versions from the release page.")).toBeTruthy()
  const link = within(section).getByRole("link", { name: "Release page" })
  // The desktop hands the fixed address to the bridge; the window itself
  // does not follow the link.
  expect(fireEvent.click(link)).toBe(false)
  expect(onOpenReleasePage).toHaveBeenCalledOnce()
})

it("links the release page directly where there is no desktop to open it", () => {
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => { throw new Error("not on this daemon") }) }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  expect(within(section).getByText("domovoid 0.9.4")).toBeTruthy()
  expect(within(section).getByRole("link", { name: "Release page" }).getAttribute("href")).toBe("https://github.com/getdomovoi/domovoi/releases")
})

// A daemon that reports a pending target is updating itself; the body stops
// saying it does not, and one line names the target (ruled 2026-09-23).
const pendingTarget = { pendingVersion: "0.9.5", pendingSourceCommit: "abcdef1".padEnd(40, "0") }
const refusal = { reason: "busy" as const, message: "A turn is running." }
it.each([
  ["pending", { state: "pending" as const, ...pendingTarget }, "The daemon reports domovoid 0.9.5 · abcdef1 waiting to switch in."],
  ["activating", { state: "activating" as const, ...pendingTarget }, "The daemon reports it is switching to domovoid 0.9.5 · abcdef1 now."],
  ["deferred", { state: "deferred" as const, ...pendingTarget, refusal }, "The daemon reports domovoid 0.9.5 · abcdef1 waiting. The switch was put off: A turn is running."],
])("names the %s update the daemon reports", async (_state, status, line) => {
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", currentSourceCommit: "3f8b01d".padEnd(40, "0"), ...status })) }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  expect(await within(section).findByText(line)).toBeTruthy()
  expect(within(section).getByText("This build is not signed. Get new versions from the release page.")).toBeTruthy()
  expect(section.textContent).not.toContain("does not update itself")
  expect(within(section).getByText("Not signed")).toBeTruthy()
})

it("adds nothing for a quarantined target", async () => {
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", currentSourceCommit: "3f8b01d".padEnd(40, "0"), state: "quarantined" as const, ...pendingTarget, refusal })) }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  expect(await within(section).findByText("domovoid 0.9.4 · 3f8b01d")).toBeTruthy()
  expect(within(section).getByText("This build is not signed and does not update itself. Get new versions from the release page.")).toBeTruthy()
  expect(section.textContent).not.toContain("The daemon reports")
})

// Owner ruling 2026-09-25: when the desktop could not open the browser, say
// so and give the address as selectable mono text to copy by hand. The status
// region is mounted before any click so a screen reader announces the change.
const failureLine = "Could not open the browser. The release page is https://github.com/getdomovoi/domovoi/releases"

function renderDesktopAbout(onOpenReleasePage: () => Promise<boolean>) {
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", state: "idle" as const })), onOpenReleasePage }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  return {
    section,
    status: () => within(section).getByRole("status"),
    // act flushes the settled open before the section is read.
    click: () => act(async () => { fireEvent.click(within(section).getByRole("link", { name: "Release page" })) }),
  }
}

function deferred() {
  let resolve!: (opened: boolean) => void
  const promise = new Promise<boolean>((settle) => { resolve = settle })
  return { promise, resolve }
}

it.each([
  ["resolves false", () => Promise.resolve(false)],
  ["rejects", () => Promise.reject(new Error("bridge refused"))],
])("gives the release page address when the desktop open %s", async (_case, open) => {
  const { status, click } = renderDesktopAbout(vi.fn(open))
  expect(status().textContent).toBe("")
  await click()
  expect(status().textContent).toBe(failureLine)
  const address = within(status()).getByText("https://github.com/getdomovoi/domovoi/releases")
  expect(address.tagName).not.toBe("A")
  expect(address.className).toContain("font-machine")
  expect(address.className).toContain("select-text")
})

it("adds no line when the desktop opens the release page", async () => {
  const onOpenReleasePage = vi.fn(async () => true)
  const { section, status, click } = renderDesktopAbout(onOpenReleasePage)
  await click()
  expect(onOpenReleasePage).toHaveBeenCalledOnce()
  expect(status().textContent).toBe("")
  expect(section.textContent).not.toContain("Could not open the browser.")
})

it("clears the line when a later click opens the browser", async () => {
  const onOpenReleasePage = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const { status, click } = renderDesktopAbout(onOpenReleasePage)
  await click()
  expect(status().textContent).toBe(failureLine)
  await click()
  expect(status().textContent).toBe("")
})

// Only the latest click speaks: an earlier open that settles late cannot
// claim a failure after a later click opened the browser.
it("ignores an earlier open that fails after a later one succeeds", async () => {
  const first = deferred()
  const second = deferred()
  const onOpenReleasePage = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const { status, click } = renderDesktopAbout(onOpenReleasePage)
  await click()
  await click()
  await act(async () => { second.resolve(true) })
  await act(async () => { first.resolve(false) })
  expect(status().textContent).toBe("")
})

it("lets a browser tab follow the release page link with no line", () => {
  render(<SettingsShell {...shellProps()} about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", state: "idle" as const })) }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  const link = within(section).getByRole("link", { name: "Release page" })
  expect(link.getAttribute("href")).toBe("https://github.com/getdomovoi/domovoi/releases")
  expect(link.getAttribute("target")).toBe("_blank")
  expect(fireEvent.click(link)).toBe(true)
  expect(section.textContent).not.toContain("Could not open the browser.")
})

// A watching window changes nothing on the daemon, but reading where new
// versions come from is not a change, so the release page still opens. The
// read-only fieldset disables form controls only, so the release page is a
// link. user-event treats anything inside a disabled fieldset as disabled,
// which a browser does not do for links, so this clicks with fireEvent.
it("opens the release page from a watching window", () => {
  const onOpenReleasePage = vi.fn(async () => true)
  render(<SettingsShell {...shellProps()} readOnly about={{ version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", state: "idle" as const })), onOpenReleasePage }} />)
  const section = screen.getByRole("region", { name: "About this build" })
  fireEvent.click(within(section).getByRole("link", { name: "Release page" }))
  expect(onOpenReleasePage).toHaveBeenCalledOnce()
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
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "linux" }} />)
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
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "darwin", service: { install: vi.fn(), remove } }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(remove).toHaveBeenCalledOnce()
  expect(await within(section).findByText("Removed. Quitting Domovoi now stops the daemon and every session on it.")).toBeTruthy()
})

// Review round 1 of #576: Remove waits for the same work Install waits for,
// and each outcome the main process can report is drawn as what is still
// true. The lines were approved by fetzy on 2026-09-23.
function daemonSection(owner: "app" | "outside", service: { install?: () => Promise<unknown>; remove?: () => Promise<unknown>; status?: () => Promise<unknown>; refusal?: string }) {
  render(<SettingsShell {...shellProps()} localDaemon={{
    title: owner === "outside" ? "Connected to the installed Domovoi service" : "Running Domovoi inside this app", detail: "", owner, ...(owner === "outside" ? { serviceInstalled: true, serviceRunning: true } : {}), platform: "darwin",
    service: { install: (service.install ?? vi.fn()) as never, remove: (service.remove ?? vi.fn()) as never, ...(service.status ? { status: service.status as never } : {}), ...(service.refusal ? { refusal: service.refusal } : {}) },
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
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped", service: { installed: false, running: false } })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl is not available", daemon: "untouched", service: { installed: false, running: false } })
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
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "The daemon runs outside this app and keeps running after it quits.", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "win32" }} />)
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
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "darwin", serviceVersion: "0.9.2", appVersion: "0.10.0" }} />)
  expect(screen.getByText("The login service runs Domovoi 0.9.2. This app is 0.10.0.")).toBeTruthy()
})

it("says nothing about versions when the service is current or newer", () => {
  const { rerender } = render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "darwin", serviceVersion: "0.10.0", appVersion: "0.10.0" }} />)
  expect(screen.queryByText(/The login service runs Domovoi/)).toBeNull()
  rerender(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "darwin", serviceVersion: "0.11.0", appVersion: "0.10.0" }} />)
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
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: true, platform: "darwin", serviceVersion: "0.9.2", appVersion: "0.10.0", service: { install: vi.fn(), remove: vi.fn(), update: update as never, ...(refusal ? { refusal } : {}) } }} />)
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

// Security review round 1 of #576. The main process reads the service back
// after a failed install or removal, and says whether the daemon it reaches
// afterwards is one this app did not start. A line that is only true when
// nothing changed is drawn only when the read-back says nothing changed. The
// other states' lines were approved by fetzy on 2026-09-25.
it("does not say nothing was installed when the service reads back as installed or cannot be read", async () => {
  const user = userEvent.setup()
  const install = vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "restarted", service: { installed: true, running: false } })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped", service: null })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "attached", service: { installed: false, running: false } })
  const section = daemonSection("app", { install })
  const button = within(section).getByRole("button", { name: "Install" })
  for (const fact of ["The LaunchAgent is installed", "Whether the LaunchAgent is installed is not known from here", "This app is connected to a daemon it did not start"]) {
    await user.click(button)
    expect(await within(section).findByText("Could not install the service")).toBeTruthy()
    expect(section.textContent).toContain(fact)
    expect(section.textContent).not.toContain("Nothing else was touched.")
    if (fact !== "This app is connected to a daemon it did not start") expect(section.textContent).not.toContain("Nothing was installed.")
  }
})

it("does not say nothing was removed when the removal stopped or deleted part of the service", async () => {
  const user = userEvent.setup()
  const remove = vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "unlink: permission denied", daemon: "restarted", service: { installed: true, running: false } })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "unlink: permission denied", daemon: "stopped", service: { installed: false, running: false } })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl could not be run", daemon: "restarted", service: null })
    .mockResolvedValueOnce({ ok: false, reason: "failed", message: "launchctl bootout exited 5", daemon: "untouched", service: { installed: true, running: true } })
  const section = daemonSection("outside", { remove })
  const button = within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" })
  for (const fact of ["The LaunchAgent is still installed but not running", "The LaunchAgent is gone", "Whether the LaunchAgent is installed is not known from here"]) {
    await user.click(button)
    expect(await within(section).findByText("Could not remove the service")).toBeTruthy()
    expect(section.textContent).toContain(fact)
    expect(section.textContent).not.toContain("Nothing was removed.")
    expect(section.textContent).not.toContain("every session keeps running")
  }
  await user.click(button)
  expect(await within(section).findByText("Nothing was removed. The LaunchAgent still holds the daemon, and every session keeps running.")).toBeTruthy()
})

it("does not say quitting stops the daemon, or that no session runs, when the removal left this app on a daemon it did not start", async () => {
  const user = userEvent.setup()
  const remove = vi.fn(async () => ({ ok: true, kind: "file", target: "/p", profileRecovery: "not-needed", daemonRunning: true, daemonAttached: true }))
  const section = daemonSection("outside", { remove })
  await user.click(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }))
  expect(await within(section).findByText(/This app is connected to a daemon it did not start/)).toBeTruthy()
  expect(section.textContent).not.toContain("Quitting Domovoi now stops the daemon")
  expect(section.textContent).not.toContain("no session is running")
})

// Another Domovoi window holds the daemon: quitting this one does not stop it,
// so the section keeps that window's own line.
it("keeps the other window's line for a daemon another Domovoi window started", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to the daemon another Domovoi Desktop started", detail: "That app owns the daemon and stops it when it quits.", owner: "other-app", platform: "darwin" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("That app owns the daemon and stops it when it quits.")
  expect(section.textContent).not.toContain("Quitting Domovoi stops the daemon")
  expect(section.textContent).not.toContain("Quitting this app leaves the daemon and its sessions running.")
})

// Review round 3 of #576: the desktop can finish an install or a removal and
// still hand this window an answer it cannot read, so an unknown answer says
// nothing about what changed. Settings reads the service back and says what
// it saw, or that it cannot tell. It never says nothing changed on its own.
it("reads the service back when the answer to an install cannot be read, and never says nothing changed", async () => {
  const user = userEvent.setup()
  const install = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
  const status = vi.fn()
    .mockResolvedValueOnce({ installed: true, running: true, detail: "pid 48213" })
    .mockResolvedValueOnce({ unavailable: "launchctl could not be run" })
    .mockRejectedValueOnce(new Error("The desktop did not answer."))
    .mockResolvedValueOnce({ installed: false, running: false, detail: "" })
  const section = daemonSection("app", { install, status })
  const button = within(section).getByRole("button", { name: "Install" })
  for (const fact of [
    "The LaunchAgent is installed and running.",
    "Whether the LaunchAgent is installed is not known from here.",
    "Whether the LaunchAgent is installed is not known from here.",
    "Nothing was installed.",
  ]) {
    await user.click(button)
    expect(await within(section).findByText(fact)).toBeTruthy()
    expect(section.textContent).toContain("Desktop returned an invalid service outcome")
    expect(section.textContent).not.toContain("Nothing changed.")
  }
  expect(status).toHaveBeenCalledTimes(4)
})

it("reads the service back when the answer to a removal cannot be read, and never says nothing changed", async () => {
  const user = userEvent.setup()
  const remove = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
  const status = vi.fn()
    .mockResolvedValueOnce({ installed: true, running: false, detail: "not loaded" })
    .mockResolvedValueOnce({ installed: null, running: false, detail: "" })
    .mockResolvedValueOnce({ installed: false, running: false, detail: "" })
  const section = daemonSection("outside", { remove, status })
  const button = within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" })
  // The last line was approved by fetzy on 2026-09-25: the removal may or may
  // not have finished, so "gone, but the removal did not finish" would claim
  // more than is known.
  for (const fact of ["The LaunchAgent is still installed but not running.", "Whether the LaunchAgent is installed is not known from here.", "The LaunchAgent is not installed."]) {
    await user.click(button)
    expect(await within(section).findByText(fact)).toBeTruthy()
    expect(section.textContent).not.toContain("Nothing changed.")
    expect(section.textContent).not.toContain("Nothing was removed.")
  }
})

it("says it cannot tell what changed when there is no way to read the service back", async () => {
  const user = userEvent.setup()
  const install = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
  const section = daemonSection("app", { install })
  await user.click(within(section).getByRole("button", { name: "Install" }))
  expect(await within(section).findByText("Whether the LaunchAgent is installed is not known from here.")).toBeTruthy()
  expect(section.textContent).not.toContain("Nothing changed.")
})

// Ruled by fetzy on 2026-09-25. An answer this window could not read, whose
// read-back shows the change happened in whole or in part, must not be headed
// "Could not install" or "Could not remove". The headers below were approved
// on 2026-09-25.
it("heads an unreadable answer by what the read-back shows, never 'Could not' after a change that happened", async () => {
  const user = userEvent.setup()
  const unreadable = vi.fn(async () => { throw new Error("Desktop returned an invalid service outcome") })
  for (const [owner, button, read, header] of [
    ["app", "Install", { installed: true, running: true }, "Could not confirm the install"],
    ["app", "Install", { installed: true, running: false }, "Could not confirm the install"],
    ["app", "Install", { installed: false, running: false }, "Could not install the service"],
    ["app", "Install", null, "Could not install the service"],
    ["outside", "Unload and delete the LaunchAgent", { installed: false, running: false }, "Could not confirm the removal"],
    ["outside", "Unload and delete the LaunchAgent", { installed: true, running: false }, "Could not confirm the removal"],
    ["outside", "Unload and delete the LaunchAgent", { installed: true, running: true }, "Could not remove the service"],
    ["outside", "Unload and delete the LaunchAgent", null, "Could not remove the service"],
  ] as const) {
    const status = vi.fn(async () => read ? { ...read, detail: "" } : { unavailable: "launchctl could not be run" })
    const section = daemonSection(owner, { install: unreadable, remove: unreadable, status })
    await user.click(within(section).getByRole("button", { name: button }))
    expect(await within(section).findByText(header)).toBeTruthy()
    if (header.startsWith("Could not confirm")) {
      expect(section.textContent).not.toContain("Could not install the service")
      expect(section.textContent).not.toContain("Could not remove the service")
    }
    cleanup()
  }
})

// Ruled by fetzy on 2026-09-25: a daemon this app did not start, when the
// service is known not installed, is named as what it is. The label, the
// status command and the lock reason stay.
it("says the login service is not installed when a daemon outside the app runs and the service is known absent", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{ title: "Connected to a daemon outside this app", detail: "", owner: "outside", serviceInstalled: false, platform: "darwin" }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("The login service is not installed. This daemon was started outside any app and runs until it is stopped.")
  expect(section.textContent).not.toContain("This app cannot tell whether that daemon is the installed service.")
  expect(within(section).getByText("Not started here")).toBeTruthy()
  expect(within(section).getByText("domovoid service status")).toBeTruthy()
  expect(section.textContent).toContain("Install and Remove are off: this app did not start that daemon.")
})

// Security review round 8 of #576: a failed install can leave the service
// installed but stopped while the daemon is back inside this app. The owner
// line stays the app's; the installed service is its own fact, so Remove is
// live, Install is off, and nothing says nothing is installed.
it("keeps Remove live for an installed service while the daemon runs inside this app", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{
    title: "Running Domovoi inside this app", detail: "", owner: "app", serviceInstalled: true, platform: "darwin",
    service: { install: vi.fn() as never, remove: vi.fn() as never },
  }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(within(section).getByText("Off")).toBeTruthy()
  expect(section.textContent).toContain("Quitting Domovoi stops the daemon and every session on it.")
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(false)
  expect(within(section).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
  expect(section.textContent).toContain("Install is off: the service is already installed.")
  expect(section.textContent).toContain("WHAT IT WROTE")
  expect(section.textContent).not.toContain("nothing is installed")
})

// The design puts About this build at the bottom of the Daemon on this
// machine card. Where that card is not drawn (a browser tab), About stands
// on its own.
it("draws About at the bottom of the daemon card, and on its own without the card", () => {
  const about = { version: "0.9.4", onUpdateStatus: vi.fn(async () => ({ channel: "stable" as const, currentVersion: "0.9.4", state: "idle" as const })) }
  const { unmount } = render(<SettingsShell {...shellProps()} about={about} localDaemon={{ title: "Running Domovoi inside this app", detail: "This app started the local daemon and stops it when the app quits.", owner: "app", platform: "darwin" }} />)
  const card = screen.getByRole("region", { name: "Daemon on this machine" })
  const inside = within(card).getByRole("region", { name: "About this build" })
  expect(card.lastElementChild).toBe(inside)
  expect(screen.getAllByRole("region", { name: "About this build" })).toHaveLength(1)
  unmount()
  render(<SettingsShell {...shellProps()} about={about} />)
  expect(screen.queryByRole("region", { name: "Daemon on this machine" })).toBeNull()
  expect(screen.getByRole("region", { name: "About this build" })).toBeTruthy()
})

// Security review round 9 of #576: the service reads back installed but not
// running while a daemon outside the app answers. That daemon is not the
// service, so the section does not call it Running or promise a restart after
// a crash; the installed service keeps Remove live.
it("does not call a daemon outside the app the running service while the service is stopped", () => {
  render(<SettingsShell {...shellProps()} localDaemon={{
    title: "Connected to the installed Domovoi service", detail: "", owner: "outside", serviceInstalled: true, serviceRunning: false, platform: "darwin",
    service: { install: vi.fn() as never, remove: vi.fn() as never },
  }} />)
  const section = screen.getByRole("region", { name: "Daemon on this machine" })
  expect(within(section).queryByText("Running")).toBeNull()
  expect(within(section).getByText("Not started here")).toBeTruthy()
  expect(section.textContent).toContain("A daemon this app did not start. Quitting this app leaves it running.")
  expect(section.textContent).not.toContain("launchd starts it again.")
  expect(within(section).getByRole("button", { name: "Unload and delete the LaunchAgent" }).hasAttribute("disabled")).toBe(false)
  expect(within(section).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
  expect(section.textContent).toContain("Install is off: the service is already installed.")
  expect(section.textContent).not.toContain("Install and Remove are off")
  expect(section.textContent).not.toContain("This app cannot tell whether that daemon is the installed service.")
  expect(section.textContent).toContain("The login service is installed but not running. This daemon was started outside any app and runs until it is stopped.")
})
