import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { FleetMachine, SessionSummary, SessionTransferResult } from "@getdomovoi/protocol"

import { TransferSessionDialog } from "./transfer-session-dialog.js"

afterEach(cleanup)

const source: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local",
  capabilities: ["sessions", "terminals"],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  protocolVersion: "0.1.0",
  transports: [{ kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true }],
  health: "healthy",
  self: true,
}

const target: FleetMachine = {
  ...source,
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  connection: "tailnet",
  self: false,
}

const session: SessionSummary = {
  id: "session-billing",
  projectId: "project-ledger",
  title: "Billing rewrite",
  state: "idle",
  runtime: { provider: "anthropic", model: "claude-opus-4", reasoning: "medium", permissionMode: "build", auto: false },
  changedFiles: 3,
  testsPassed: 12,
  testsFailed: 0,
  updatedAt: "2026-08-31T12:00:00.000Z",
  workspacePath: "/worktrees/session-billing",
}

const succeeded: SessionTransferResult = {
  outcome: "succeeded",
  workspacePath: "/worktrees/session-billing",
  checkpointCommit: "c".repeat(40),
}

function renderDialog(overrides: {
  session?: SessionSummary
  target?: FleetMachine
  onTransfer?: (params: unknown) => Promise<SessionTransferResult>
  onTransferred?: (machineId: string) => void
  onOutcome?: (result: SessionTransferResult) => void
} = {}) {
  const onTransfer = vi.fn(overrides.onTransfer ?? (() => Promise.resolve(succeeded)))
  const onTransferred = vi.fn(overrides.onTransferred ?? (() => {}))
  const onOutcome = vi.fn(overrides.onOutcome ?? (() => {}))
  const user = userEvent.setup()
  render(
    <TransferSessionDialog
      open
      onOpenChange={() => {}}
      session={overrides.session ?? session}
      source={source}
      target={overrides.target ?? target}
      onTransfer={onTransfer as never}
      onTransferred={onTransferred}
      onOutcome={onOutcome}
    />,
  )
  return { user, onTransfer, onTransferred, onOutcome }
}

it("names the machine the session would move to", () => {
  renderDialog()

  expect(screen.getByRole("heading", { name: "Move session to studio" })).toBeTruthy()
})

it("reports that both ends are ready before the move", () => {
  renderDialog()

  const checks = screen.getByRole("group", { name: "Transfer checks" })
  expect(checks.textContent).toContain("This session is ready to move")
  expect(checks.textContent).toContain("studio can receive it")
})

it("refuses a session that is mid turn and says why", () => {
  renderDialog({ session: { ...session, state: "active", activeTurnId: "turn-1" } })

  expect(screen.getByRole("group", { name: "Transfer checks" }).textContent)
    .toContain("This session is mid turn, so it cannot move until the turn settles")
  expect(screen.getByRole("button", { name: "Move session" }).hasAttribute("disabled")).toBe(true)
})

it("refuses a target that needs an upgrade and says why", () => {
  renderDialog({ target: { ...target, health: "upgrade-required" } })

  expect(screen.getByRole("group", { name: "Transfer checks" }).textContent)
    .toContain("That machine runs an older Domovoi and needs an upgrade first")
  expect(screen.getByRole("button", { name: "Move session" }).hasAttribute("disabled")).toBe(true)
})

it("lists what travels with the session", () => {
  renderDialog()

  const travels = screen.getByRole("group", { name: "Travels with the session" })
  for (const item of [
    "Thread",
    "Plan",
    "Tool and test results",
    "Open annotations",
    "Active skills",
    "Permission mode",
    "Tracked changes",
    "Non-ignored untracked files",
  ]) expect(travels.textContent).toContain(item)
})

it("lists what does not travel with the session", () => {
  renderDialog()

  const stays = screen.getByRole("group", { name: "Does not travel" })
  for (const item of [
    "Running dev servers and PTYs, which restart there",
    "Provider credentials",
    ".env and secrets",
    "Database state",
    "Ignored build artifacts",
  ]) expect(stays.textContent).toContain(item)
})

it("moves the session with a git bundle by default", async () => {
  const { user, onTransfer } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransfer).toHaveBeenCalledWith({
    sessionId: "session-billing",
    targetMachineId: target.id,
    method: "git-bundle",
  })
})

it("needs a remote name before a remote ref transfer can run", async () => {
  const { user, onTransfer } = renderDialog()

  await user.click(screen.getByRole("radio", { name: /remote ref/i }))

  expect(screen.getByRole("button", { name: "Move session" }).hasAttribute("disabled")).toBe(true)
  expect(onTransfer).not.toHaveBeenCalled()
})

it("moves the session over the named remote", async () => {
  const { user, onTransfer } = renderDialog()

  await user.click(screen.getByRole("radio", { name: /remote ref/i }))
  await user.type(screen.getByLabelText("Remote name"), "origin")
  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransfer).toHaveBeenCalledWith({
    sessionId: "session-billing",
    targetMachineId: target.id,
    method: "remote-ref",
    remote: "origin",
  })
})

it("switches to the target once the session lands there", async () => {
  const { user, onTransferred, onOutcome } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransferred).toHaveBeenCalledWith(target.id)
  expect(onOutcome).toHaveBeenCalledWith(succeeded)
})

it("states the reason the daemon refused rather than a generic failure", async () => {
  const refused: SessionTransferResult = { outcome: "refused", reason: "target-not-responding" }
  const { user, onTransferred, onOutcome } = renderDialog({
    onTransfer: () => Promise.resolve(refused),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(screen.getByRole("alert").textContent)
    .toContain("That machine is not answering, so the session cannot move to it now")
  expect(onOutcome).toHaveBeenCalledWith(refused)
  expect(onTransferred).not.toHaveBeenCalled()
})

it("keeps the session where it is when the move fails", async () => {
  const { user, onTransferred } = renderDialog({
    onTransfer: () => Promise.resolve({ outcome: "failed" }),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(screen.getByRole("alert").textContent)
    .toContain("The session did not move and stayed on workshop")
  expect(onTransferred).not.toHaveBeenCalled()
})

it("reports a transport error without claiming the session moved", async () => {
  const { user, onTransferred } = renderDialog({
    onTransfer: () => Promise.reject(new Error("Daemon connection is not open")),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(screen.getByRole("alert").textContent).toContain("Daemon connection is not open")
  expect(onTransferred).not.toHaveBeenCalled()
})
