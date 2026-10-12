import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { sessionTransferContractVersion } from "@getdomovoi/protocol"
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
  contractVersion: sessionTransferContractVersion,
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
  machines?: readonly FleetMachine[]
} = {}) {
  const onTargetChange = vi.fn<(machineId: string) => void>()
  const onTransfer = vi.fn(overrides.onTransfer ?? (() => Promise.resolve(succeeded)))
  const onTransferred = vi.fn(overrides.onTransferred ?? (() => {}))
  const onOutcome = vi.fn(overrides.onOutcome ?? (() => {}))
  const onPreview = vi.fn(async () => ({
    allowed: true as const,
    contractVersion: sessionTransferContractVersion,
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
      {...(overrides.machines ? { targetChoice: { machines: overrides.machines, onTargetChange } } : {})}
    />,
  )
  return { user, onPreview, onTransfer, onTransferred, onOutcome, onTargetChange }
}

const offline: FleetMachine = {
  ...target,
  id: `machine-${"c".repeat(32)}`,
  label: "attic",
  connection: "lan",
  heartbeat: { state: "offline", lastSeenAt: "2026-08-31T11:00:00.000Z" },
  health: "unreachable",
}

const spare: FleetMachine = {
  ...target,
  id: `machine-${"d".repeat(32)}`,
  label: "garage",
  connection: "lan",
}

it("lists every machine as a target with what it can accept", () => {
  renderDialog({ machines: [source, target, offline] })

  const list = screen.getByRole("radiogroup", { name: "TARGET" })
  expect(within(list).getAllByRole("radio")).toHaveLength(3)

  const here = within(list).getByRole("radio", { name: "workshop" })
  expect(here).toHaveProperty("disabled", true)
  expect(here).toHaveProperty("checked", false)
  expect(describedBy(here)).toBe("this machine, the session is already here")

  const chosen = within(list).getByRole("radio", { name: "studio" })
  expect(chosen).toHaveProperty("disabled", false)
  expect(chosen).toHaveProperty("checked", true)
  expect(describedBy(chosen)).toBe("reachable over tailnet")

  const away = within(list).getByRole("radio", { name: "attic" })
  expect(away).toHaveProperty("disabled", true)
  expect(describedBy(away)).toBe("daemon unreachable, cannot accept a session now")
})

it("blames this side's keychain, not the target's daemon, when the keychain cannot be read", () => {
  renderDialog({ machines: [source, target, { ...spare, health: "credential-store-unavailable" }] })

  const row = screen.getByRole("radio", { name: "garage" })
  expect(row).toHaveProperty("disabled", true)
  expect(describedBy(row)).toBe("the keychain here could not be read, cannot reach it now")
})

// The daemon may still dial it over an SSH forward or a WSL distribution on
// the source, neither of which the fleet entry shows, so the row is offered
// without claiming a route and the preview settles it.
it("neither claims nor refuses a route for a healthy machine that advertises none", () => {
  renderDialog({ machines: [source, target, { ...spare, connection: "ssh", transports: [] }] })

  const row = screen.getByRole("radio", { name: "garage" })
  expect(row).toHaveProperty("disabled", false)
  expect(describedBy(row)).toBe("no advertised route, the preview says whether it can be dialed")
})

it("moves the choice to another reachable machine", async () => {
  const { user, onTargetChange } = renderDialog({ machines: [source, target, spare] })

  await user.click(screen.getByRole("radio", { name: "garage" }))

  expect(onTargetChange).toHaveBeenCalledWith(spare.id)
})

it("does not offer the move to a newly picked machine on the previous machine's preview", async () => {
  const onPreview = vi.fn(async (params: { targetMachineId: string }) => ({
    allowed: true as const,
    contractVersion: sessionTransferContractVersion,
    sessionId: session.id,
    sourceMachineId: source.id,
    targetMachineId: params.targetMachineId,
    intentDigest: `sha256:${(params.targetMachineId === target.id ? "a" : "e").repeat(64)}`,
    project: {
      sourceProjectId: "project-ledger",
      targetProjectId: "project-ledger-target",
      lineageCommit: "b".repeat(40),
      sourceHeadCommit: "c".repeat(40),
    },
    coverage: { included: [{ kind: "thread" as const }], excluded: [], warnings: [] },
  }))
  const onTransfer = vi.fn(() => Promise.resolve(succeeded))
  function Opener() {
    const [chosen, setChosen] = useState(target)
    return (
      <TransferSessionDialog
        open
        onOpenChange={() => {}}
        session={session}
        source={source}
        target={chosen}
        onPreview={onPreview as never}
        onTransfer={onTransfer as never}
        onTransferred={() => {}}
        onOutcome={() => {}}
        targetChoice={{
          machines: [source, target, spare],
          onTargetChange: (id) => setChosen([target, spare].find((machine) => machine.id === id)!),
        }}
      />
    )
  }
  const user = userEvent.setup()
  render(<Opener />)
  await user.click(screen.getByRole("radio", { name: /remote ref/i }))
  await user.type(screen.getByLabelText("Remote name"), "origin")
  const move = screen.getByRole("button", { name: "Move session" })
  await waitFor(() => expect(move).toHaveProperty("disabled", false))

  // The remote preview waits out its debounce, so the old one is still held
  // when the new machine is chosen.
  await user.click(screen.getByRole("radio", { name: "garage" }))

  expect(move).toHaveProperty("disabled", true)
  expect(screen.queryByRole("group", { name: "Travels with the session" })).toBeNull()
  await waitFor(() => expect(move).toHaveProperty("disabled", false))
  await user.click(move)
  expect(onTransfer).toHaveBeenCalledWith(expect.objectContaining({
    targetMachineId: spare.id,
    intentDigest: `sha256:${"e".repeat(64)}`,
  }))
})

it("asks for a reachable machine when the chosen one cannot accept the session", () => {
  renderDialog({ machines: [source, offline, spare], target: offline })

  const move = screen.getByRole("button", { name: "Move session" })
  expect(move.textContent).toBe("Pick a reachable machine")
  expect(move).toHaveProperty("disabled", true)
})

it("draws the chosen machine alone when no machine list is given", () => {
  renderDialog()

  expect(screen.queryByRole("radiogroup", { name: "TARGET" })).toBeNull()
  expect(screen.getByRole("region", { name: "TARGET" }).textContent).toContain("studio")
  expect(screen.getByRole("button", { name: "Move session" }).textContent).toBe("Move to studio")
})

it("counts the checks in words the design uses", () => {
  renderDialog()

  expect(screen.getByText("2 pass")).toBeTruthy()
  expect(screen.queryByText(/warnings?$/u)).toBeNull()
})

it("counts a refused check as blocking, in the singular", () => {
  renderDialog({ target: { ...target, health: "upgrade-required" } })

  expect(screen.getByText("1 pass · 1 blocking")).toBeTruthy()
})

function describedBy(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim()
}

it("matches the v2 transfer preflight contract", async () => {
  renderDialog()

  expect(screen.getByRole("heading", { name: "Move this session to another machine" })).toBeTruthy()
  expect(screen.getByText("PRE-FLIGHT ON STUDIO")).toBeTruthy()
  expect(screen.getByText("Running processes are not moved", { exact: false })).toBeTruthy()
  expect(await screen.findByRole("group", { name: "Travels with the session" })).toBeTruthy()
  expect(screen.getByText(
    "Not sent either way: shell history, background processes, anything written outside the worktree, and credentials. The target authenticates its own providers.",
  )).toBeTruthy()
  expect(screen.getByText("Move to studio")).toBeTruthy()
})

it("names the target machine in the preflight", () => {
  renderDialog()

  expect(screen.getByText("studio can receive it")).toBeTruthy()
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
    contractVersion: sessionTransferContractVersion,
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
  // The remote preview waits for typing to stop, so the move is not offered
  // until that request has answered.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Move session" }).hasAttribute("disabled")).toBe(false))
  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransfer).toHaveBeenCalledWith({
    contractVersion: sessionTransferContractVersion,
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
    recoveryAction: "none",
  }
  const { user } = renderDialog({ onTransfer: () => Promise.resolve(stalled) })
  await screen.findByRole("group", { name: "Travels with the session" })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("The move failed")
  expect(alert.textContent).toContain("artifacts and attachments could not be imported")
  expect(alert.textContent).toContain("workshop")
  expect(screen.getByRole("region", { name: "Half-failed move" })).toBeTruthy()
  expect(screen.getByText("Recover the source and keep working here")).toBeTruthy()
  expect(screen.getByText("Retry the move")).toBeTruthy()
})

it("explains a refusal caused by moving a session back where it came from", async () => {
  const refused: SessionTransferResult = { outcome: "refused", reason: "target-session-diverged" }
  renderDialog({
    session: {
      ...session,
      transferredFrom: {
        transferId: `transfer-${"e".repeat(32)}`,
        sourceMachineId: target.id,
        generation: 1,
        manifestDigest: `sha256:${"f".repeat(64)}`,
        checkpointCommit: "a".repeat(40),
        completedAt: "2026-09-01T09:00:00.000Z",
      },
    } as typeof session,
    onTransfer: () => Promise.resolve(refused),
  })
  const { user } = { user: userEvent.setup() }
  await screen.findByRole("group", { name: "Travels with the session" })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("needs manual recovery")
  expect(alert.textContent).toContain("came from studio")
})

it("keeps the session where it is when the move fails", async () => {
  const { user, onTransferred } = renderDialog({
    onTransfer: () => Promise.resolve({
      outcome: "incomplete" as const,
      transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      state: "failed" as const,
      reason: "persistence-failed" as const,
      recoveryAction: "none" as const,
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
    contractVersion: sessionTransferContractVersion,
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
