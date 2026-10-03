import type { ProviderRuntime } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DaemonServiceOutcome } from "./desktop-platform.js"
import { DesktopFirstRunDialog } from "./desktop-first-run.js"
import { completeDesktopFirstRun, desktopFirstRunStorageKey, loadDesktopFirstRunState, saveDesktopFirstRunState } from "./desktop-first-run-persistence.js"
import { FirstRunServiceContext, type FirstRunService } from "./desktop-first-run-service.js"

const codex: ProviderRuntime = { id: "codex", command: "codex", status: "ready", version: "0.149.0", sessionCapable: true }
const claude: ProviderRuntime = { id: "claude-code", command: "claude", status: "auth-required", version: "2.1.8", sessionCapable: true }
const opencode: ProviderRuntime = { id: "opencode", command: "opencode", status: "missing", sessionCapable: true }

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

function setup({ service, ...overrides }: Partial<ComponentProps<typeof DesktopFirstRunDialog>> & { service?: FirstRunService } = {}) {
  const props = {
    open: true,
    connected: true,
    machine: { name: "mac-mini-m4", platform: "darwin", version: "0.9.4" },
    providers: [codex, claude, opencode],
    sessions: [],
    selectedProviderId: "codex",
    permissionMode: "build" as const,
    refreshing: false,
    recoveryError: "",
    onProviderChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onRetry: vi.fn(),
    onCopyGuidance: vi.fn(),
    onSkip: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  }
  const dialog = <DesktopFirstRunDialog {...props} />
  render(service ? <FirstRunServiceContext.Provider value={service}>{dialog}</FirstRunServiceContext.Provider> : dialog)
  return { props, user: userEvent.setup() }
}

const inApp = (install: () => Promise<DaemonServiceOutcome>, platform: FirstRunService["platform"] = "darwin"): FirstRunService => ({ owner: "app", platform, install })

describe("desktop first run", () => {
  // Q351 A: the daemon ships inside the app, so setup starts at keeping it
  // running after quit, and "No daemon is running" is never drawn.
  it("starts at keeping Domovoi running after you quit, with Not now", () => {
    setup({ service: inApp(vi.fn()) })
    expect(screen.getByRole("heading", { name: "Keep Domovoi running after you quit" })).toBeTruthy()
    expect(screen.getByText("The daemon lives inside this app for now, so quitting it stops every session. The service moves it under your login.")).toBeTruthy()
    expect(screen.getByText("What installing does")).toBeTruthy()
    expect(screen.getByText("For your user only. Nothing is system-wide.")).toBeTruthy()
    const rows = screen.getByRole("list", { name: "What installing does" })
    expect(rows.textContent).toContain("~/Library/LaunchAgents/sh.domovoi.domovoid.plist")
    expect(rows.textContent).toContain("~/.domovoi/service.json")
    expect(rows.textContent).toContain("Hand this app's daemon to launchd")
    expect(screen.getByRole("button", { name: "Install the service" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy()
    expect(screen.getByText("Remove it any time in Settings.")).toBeTruthy()
    expect(screen.getByText("domovoid 0.9.4")).toBeTruthy()
    expect(screen.getByText("This build is not signed and does not update itself.")).toBeTruthy()
    expect(screen.getByText("daemon 0.9.4 · in this app")).toBeTruthy()
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("No daemon is running")
    expect(text).not.toContain("A good spirit lives in your machines.")
    expect(text).not.toMatch(/daemon install|machine add|domovoi join|brew install|7717/u)
  })

  // Q352 A: no permission-mode step; new sessions default to Build manual.
  it("draws no permission-mode step", () => {
    setup({ service: inApp(vi.fn()) })
    expect(document.body.textContent).not.toContain("Choose a permission mode for new projects")
    expect(screen.queryByRole("radiogroup", { name: "Default permission mode" })).toBeNull()
  })

  it("installs the service from setup, says what it did, then moves on to the agents", async () => {
    const install = vi.fn(async (): Promise<DaemonServiceOutcome> => ({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.domovoid.plist", daemonRunning: true }))
    const { user } = setup({ service: inApp(install) })
    await user.click(screen.getByRole("button", { name: "Install the service" }))
    expect(install).toHaveBeenCalledOnce()
    expect(await screen.findByRole("heading", { name: "The service is installed" })).toBeTruthy()
    expect(screen.getByText("What it did")).toBeTruthy()
    expect(screen.getByText("Domovoi is running as a login service. It starts when you log in. It answers on loopback only.")).toBeTruthy()
    expect(screen.getByText("daemon 0.9.4 · login service")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Connect an agent" }))
    expect(screen.getByRole("heading", { name: "Connect an agent on mac-mini-m4" })).toBeTruthy()
  })

  it("says what failed and what still works when the install fails", async () => {
    const install = vi.fn(async (): Promise<DaemonServiceOutcome> => ({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5: Input/output error", daemon: "restarted", service: { installed: false, running: false } }))
    const { user } = setup({ service: inApp(install) })
    await user.click(screen.getByRole("button", { name: "Install the service" }))
    expect(await screen.findByRole("heading", { name: "The service was not installed" })).toBeTruthy()
    expect(screen.getByText("WHAT FAILED")).toBeTruthy()
    // The desktop reports the final outcome only, so the failed action is
    // named by the daemon's own error, not guessed.
    expect(screen.getByText("Domovoi could not install the LaunchAgent.")).toBeTruthy()
    expect(screen.getByText("launchctl bootstrap exited 5: Input/output error")).toBeTruthy()
    expect(screen.getByText("WHAT STILL WORKS")).toBeTruthy()
    expect(screen.getByText("The daemon is back inside this app. Nothing else was touched.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Continue without the service" }))
    expect(screen.getByRole("heading", { name: "Connect an agent on mac-mini-m4" })).toBeTruthy()
  })

  // Review P3-6: "was not installed" only when the read-back says so. An
  // unread answer, or a service read back installed, did not finish.
  it.each([
    ["the service could not be read back", async (): Promise<DaemonServiceOutcome> => ({ ok: false, reason: "failed", message: "launchctl exited 5", daemon: "untouched", service: null })],
    ["the service reads back installed", async (): Promise<DaemonServiceOutcome> => ({ ok: false, reason: "failed", message: "launchctl exited 5", daemon: "restarted", service: { installed: true, running: false } })],
    ["the answer could not be read", async (): Promise<DaemonServiceOutcome> => { throw new Error("Desktop returned an invalid service outcome") }],
  ])("says the install did not finish when %s", async (_label, install) => {
    const { user } = setup({ service: inApp(install) })
    await user.click(screen.getByRole("button", { name: "Install the service" }))
    expect(await screen.findByRole("heading", { name: "The install did not finish" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "The service was not installed" })).toBeNull()
  })

  // Review P3-7: setup stays open while the install runs, so its outcome is
  // never lost behind a closed dialog.
  it("cannot be skipped or escaped while the install runs", async () => {
    let finish: (outcome: DaemonServiceOutcome) => void = () => {}
    const install = vi.fn(() => new Promise<DaemonServiceOutcome>((resolve) => { finish = resolve }))
    const { props, user } = setup({ service: inApp(install) })
    await user.click(screen.getByRole("button", { name: "Install the service" }))
    expect(await screen.findByRole("heading", { name: "Installing the login service" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true)
    await user.keyboard("{Escape}")
    expect(props.onSkip).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeTruthy()
    finish({ ok: true, kind: "file", target: "/p", daemonRunning: true })
    expect(await screen.findByRole("heading", { name: "The service is installed" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false)
  })

  it("goes straight to the agents when the daemon is not this app's, or nothing can install it", () => {
    setup({ service: { owner: "outside", platform: "darwin", install: vi.fn() } })
    expect(screen.getByRole("heading", { name: "Connect an agent on mac-mini-m4" })).toBeTruthy()
    cleanup()
    setup()
    expect(screen.getByRole("heading", { name: "Connect an agent on mac-mini-m4" })).toBeTruthy()
  })

  // Q353 A: one card per agent. The action copies the provider CLI's own
  // sign-in command; a missing CLI gets guidance, never an installer.
  it("draws one card per agent, copying the CLI's own sign-in command and guiding a missing CLI", async () => {
    const { props, user } = setup({ service: inApp(vi.fn()) })
    await user.click(screen.getByRole("button", { name: "Not now" }))
    const cards = screen.getByRole("list", { name: "Agents on this machine" })
    const card = (name: string) => within(cards).getByText(name, { selector: "[data-agent-name]" }).closest("li")!
    expect(within(card("codex")).getByText("0.149.0 · found in PATH")).toBeTruthy()
    expect(within(card("codex")).queryByRole("button")).toBeNull()
    expect(within(card("claude-code")).getByText("claude auth login")).toBeTruthy()
    await user.click(within(card("claude-code")).getByRole("button", { name: "Copy sign-in command" }))
    expect(props.onCopyGuidance).toHaveBeenCalledWith("claude auth login")
    expect(within(card("opencode")).getByText("not found")).toBeTruthy()
    expect(card("opencode").textContent).toContain("Domovoi will not install agents for you, it only runs what is already on the machine.")
    await user.click(within(card("opencode")).getByRole("button", { name: "Install guide" }))
    expect(card("opencode").textContent).toContain("Install it with the provider's own instructions so that opencode is on the PATH the daemon searches, then press Retry diagnostics.")
    expect(document.body.textContent).not.toMatch(/Paste a key|domovoi auth|pipx install|npm install|brew install/u)
  })

  it("finishes setup without a ready agent and does not open again on the next launch", async () => {
    const { props, user } = setup({ providers: [claude, opencode], selectedProviderId: "claude-code" })
    await user.click(screen.getByRole("button", { name: "One machine is enough for now" }))
    expect(props.onComplete).not.toHaveBeenCalled()
    expect(props.onSkip).toHaveBeenCalledOnce()
    expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")
  })

  it("finishes with the ready agent through the shell's completion", async () => {
    const { props, user } = setup()
    await user.click(screen.getByRole("button", { name: "One machine is enough for now" }))
    expect(props.onComplete).toHaveBeenCalledOnce()
    expect(props.onSkip).not.toHaveBeenCalled()
  })

  it("remembers Skip for now, and never turns a completed setup into a dismissed one", async () => {
    const { props, user } = setup({ service: inApp(vi.fn()) })
    await user.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(props.onSkip).toHaveBeenCalledOnce()
    expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")
    cleanup()
    const completed = completeDesktopFirstRun({ providerId: "codex", completedAt: "2026-10-02T09:00:00.000Z" })
    saveDesktopFirstRunState(localStorage, completed)
    const again = setup()
    await again.user.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(JSON.parse(localStorage.getItem(desktopFirstRunStorageKey)!)).toEqual(completed)
  })
})
