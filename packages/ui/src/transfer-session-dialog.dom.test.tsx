import { cleanup, render, screen, waitFor } from "@testing-library/react"
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
  contractVersion: 1,
  transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownershipGeneration: 2,
  coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
}

function renderDialog(overrides: {
  session?: SessionSummary
  target?: FleetMachine
  onTransfer?: (params: unknown) => Promise<SessionTransferResult>
  onTransferred?: (machineId: string) => void
  onOutcome?: (result: SessionTransferResult) => void
  coverage?: unknown
} = {}) {
  const onTransfer = vi.fn(overrides.onTransfer ?? (() => Promise.resolve(succeeded)))
  const onTransferred = vi.fn(overrides.onTransferred ?? (() => {}))
  const onOutcome = vi.fn(overrides.onOutcome ?? (() => {}))
  const onPreview = vi.fn(async () => ({
    allowed: true as const,
    contractVersion: 1 as const,
    sessionId: session.id,
    sourceMachineId: source.id,
    targetMachineId: target.id,
    intentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    project: {
      sourceProjectId: "project-ledger",
      targetProjectId: "project-ledger-target",
      lineageCommit: "b".repeat(40),
      sourceHeadCommit: "c".repeat(40),
    },
    coverage: overrides.coverage ?? {
      included: [
        { kind: "repository" as const },
        { kind: "thread" as const },
        { kind: "working-plan" as const },
        { kind: "annotations" as const },
      ],
      excluded: [
        { kind: "terminals" as const },
        { kind: "provider-credentials" as const },
        { kind: "skill-authority" as const },
        { kind: "approval-rules" as const },
        { kind: "ignored-files" as const },
      ],
      warnings: [{ kind: "tracked-sensitive-files-may-travel" as const }],
    },
  }))
  const user = userEvent.setup()
  render(
    <TransferSessionDialog
      open
      onOpenChange={() => {}}
      session={overrides.session ?? session}
      source={source}
      target={overrides.target ?? target}
      onPreview={onPreview as never}
      onTransfer={onTransfer as never}
      onTransferred={onTransferred}
      onOutcome={onOutcome}
    />,
  )
  return { user, onPreview, onTransfer, onTransferred, onOutcome }
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

it("lists what travels with the session", async () => {
  renderDialog()

  const travels = await screen.findByRole("group", { name: "Travels with the session" })
  for (const item of [
    "Repository, at the checkpoint commit",
    "Thread",
    "Working plan",
    "Annotations",
  ]) expect(travels.textContent).toContain(item)
})

it("lists what does not travel with the session", async () => {
  renderDialog()

  const stays = await screen.findByRole("group", { name: "Does not travel" })
  for (const item of [
    "Running dev servers and terminals, which restart there",
    "Provider credentials",
    "Skills enabled for this project, which are reviewed again there",
    "Standing approval rules, which are approved again there",
    "Ignored files, including ignored build output",
  ]) expect(stays.textContent).toContain(item)
})

it("moves the session with a git bundle by default", async () => {
  const { user, onTransfer } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransfer).toHaveBeenCalledWith({
    contractVersion: 1,
    intentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    contractVersion: 1,
    intentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

it("tells the operator to pair the target again when its credential was retired", async () => {
  const refused: SessionTransferResult = { outcome: "refused", reason: "target-pairing-required" }
  const { user } = renderDialog({ onTransfer: () => Promise.resolve(refused) })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(screen.getByRole("alert").textContent)
    .toContain("That machine must be paired again before a session can move to it")
})

it("lists what the daemon says the move carries, not a list written here", async () => {
  renderDialog({
    coverage: {
      included: [{ kind: "thread" }, { kind: "artifacts", count: 2 }],
      excluded: [{ kind: "terminals" }],
      warnings: [{ kind: "provider-restart-required" }],
    },
  })

  const carried = await screen.findByRole("group", { name: "Travels with the session" })

  expect(carried.textContent).toContain("Thread")
  expect(carried.textContent).toContain("Artifacts (2)")
  expect(carried.textContent).not.toContain("Repository")
  expect(screen.getByRole("group", { name: "Does not travel" }).textContent)
    .toContain("Running dev servers and terminals, which restart there")
  expect(screen.getByText(/The provider has to be started again on the target/)).toBeTruthy()
})

it("previews again when the session changed under the preview", async () => {
  const refused: SessionTransferResult = { outcome: "refused", reason: "session-state-changed" }
  const { user, onPreview } = renderDialog({ onTransfer: () => Promise.resolve(refused) })
  await screen.findByRole("group", { name: "Travels with the session" })
  expect(onPreview).toHaveBeenCalledOnce()

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(screen.getByRole("alert").textContent)
    .toContain("The session changed after the transfer preview, so review the move again")
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2))
})

it("says which stage an unfinished move reached and what answers it", async () => {
  const stalled: SessionTransferResult = {
    outcome: "incomplete",
    transferId: `transfer-${"a".repeat(32)}`,
    state: "failed",
    reason: "resource-import-failed",
    recoveryAction: "retry",
  }
  const { user } = renderDialog({ onTransfer: () => Promise.resolve(stalled) })
  await screen.findByRole("group", { name: "Travels with the session" })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("The move failed")
  expect(alert.textContent).toContain("artifacts and attachments could not be imported")
  expect(alert.textContent).toContain("workshop")
})

it("keeps the session where it is when the move fails", async () => {
  const { user, onTransferred } = renderDialog({
    onTransfer: () => Promise.resolve({
      outcome: "incomplete" as const,
      transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      state: "failed" as const,
      reason: "persistence-failed" as const,
      recoveryAction: "retry" as const,
    }),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("The session stayed on workshop")
  expect(alert.textContent).toContain("could not save the session it received")
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

it("does not promise that secrets stay behind", async () => {
  renderDialog()

  await screen.findByRole("group", { name: "Does not travel" })
  expect(screen.queryByText(".env and secrets")).toBeNull()
  expect(screen.getByText(/travels regardless of its name/u)).toBeTruthy()
})

it("does not promise that skills travel", async () => {
  renderDialog()

  await screen.findByRole("group", { name: "Does not travel" })
  expect(screen.queryByText("Active skills")).toBeNull()
  expect(screen.getByText(/reviewed again there/u)).toBeTruthy()
})

it("waits for the daemon to allow the move before offering it", async () => {
  const onPreview = vi.fn(() => new Promise(() => {}))
  render(
    <TransferSessionDialog
      open
      onOpenChange={() => {}}
      session={session}
      source={source}
      target={target}
      onPreview={onPreview as never}
      onTransfer={vi.fn() as never}
      onTransferred={() => {}}
      onOutcome={() => {}}
    />,
  )

  expect(screen.getByRole("button", { name: "Move session" })).toHaveProperty("disabled", true)
  expect(onPreview).toHaveBeenCalledOnce()
})

it("offers no move when the daemon refuses to preview one", async () => {
  const onPreview = vi.fn(async () => ({
    allowed: false as const,
    contractVersion: 1 as const,
    sessionId: session.id,
    sourceMachineId: source.id,
    targetMachineId: target.id,
    reason: "session-not-idle" as const,
    coverage: { included: [], excluded: [], warnings: [] },
  }))
  render(
    <TransferSessionDialog
      open
      onOpenChange={() => {}}
      session={session}
      source={source}
      target={target}
      onPreview={onPreview as never}
      onTransfer={vi.fn() as never}
      onTransferred={() => {}}
      onOutcome={() => {}}
    />,
  )

  await waitFor(() => expect(onPreview).toHaveBeenCalledOnce())
  expect(screen.getByRole("button", { name: "Move session" })).toHaveProperty("disabled", true)
})
