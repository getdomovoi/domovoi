import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, sessionTransferContractVersion, type FleetMachine, type SessionTransferResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { isLoadingLine } from "./start-handoff"
import { ThreadWithDrawerMove } from "./test-support/drawer-move"

// The dialog's code loads on first use. The first test holds its chunk back
// until it has seen the loading line; the module is then cached, so every
// later test gets it at once.
const chunk = vi.hoisted(() => {
  let release = () => {}
  const open = new Promise<void>((resolve) => { release = resolve })
  return { open, release, held: false }
})
vi.mock("./transfer-session-dialog.js", async (importOriginal) => {
  if (chunk.held) await chunk.open
  return importOriginal()
})

afterEach(() => {
  cleanup()
  // A held chunk is let go even when the holding test failed first.
  chunk.release()
})

const handlers = {
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
}

function movableSnapshot(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions = snapshot.sessions.map((session) => {
    const { activeTurnId: _turn, ...rest } = session
    return { ...rest, state: "idle" as const, workspacePath: "/worktrees/session" }
  })
  snapshot.activeSessionId = snapshot.sessions[0]?.id ?? null
  snapshot.approvals = []
  return snapshot
}

function fleetFor(snapshot: WorkspaceSnapshot): [FleetMachine, FleetMachine] {
  const local: FleetMachine = {
    id: snapshot.machine.id,
    label: snapshot.machine.name,
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "local",
    capabilities: ["sessions"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true }],
    heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
    health: "healthy",
    self: true,
  }
  const studio: FleetMachine = {
    ...local,
    id: `machine-${"b".repeat(32)}`,
    label: "studio",
    connection: "tailnet",
    transports: [{ kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true }],
    self: false,
  }
  return [local, studio]
}

async function openTransferDialog(result: SessionTransferResult) {
  const snapshot = movableSnapshot()
  const [local, studio] = fleetFor(snapshot)
  const onTransferSession = vi.fn(() => Promise.resolve(result))
  const onSelectMachine = vi.fn()
  const user = userEvent.setup()
  render(
    <ThreadWithDrawerMove
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      fleet={[local, studio].map((machine) => ({ kind: "machine" as const, machine }))}
      currentMachineId={local.id}
      onSelectMachine={onSelectMachine}
      onTransferSession={onTransferSession}
      onPreviewTransfer={(async () => ({
        allowed: true,
        contractVersion: sessionTransferContractVersion,
        sessionId: "session-billing",
        sourceMachineId: "machine-local",
        targetMachineId: "machine-studio",
        intentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        project: {
          sourceProjectId: "project-one",
          targetProjectId: "project-two",
          lineageCommit: "b".repeat(40),
          sourceHeadCommit: "c".repeat(40),
        },
        coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
      })) as never}
      {...handlers}
    />,
  )
  await user.click(screen.getByRole("button", { name: "Move to another machine" }))
  await user.click(screen.getByRole("menuitem", { name: /move this session to studio/i }))
  // The dialog's code loads on first use; a held chunk is the test's to let go.
  if (!chunk.held) await screen.findByRole("heading", { name: "Move this session to another machine" })
  return { user, snapshot, studio, onTransferSession, onSelectMachine }
}

// The dialog is drawn only once a move has been asked for, so its code loads
// on first use behind the registered loading line, as a surface's does. The
// line takes no focus of its own: the menu's close returns focus to where it
// was, and the dialog takes it once its code lands.
it("loads the dialog's code on first use behind the registered loading line", async () => {
  chunk.held = true
  await openTransferDialog({
    outcome: "succeeded",
    contractVersion: sessionTransferContractVersion,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  const line = screen.getByText("Opening the move dialog")
  expect(line.getAttribute("role")).toBe("status")
  expect(isLoadingLine(line)).toBe(true)
  expect(document.activeElement).not.toBe(line)
  expect(screen.queryByRole("heading", { name: "Move this session to another machine" })).toBeNull()

  chunk.release()
  expect(await screen.findByRole("heading", { name: "Move this session to another machine" })).toBeTruthy()
  expect(screen.queryByText("Opening the move dialog")).toBeNull()
  expect(isLoadingLine(line)).toBe(false)
})

it("opens the transfer dialog from the composer device menu", async () => {
  await openTransferDialog({
    outcome: "succeeded",
    contractVersion: sessionTransferContractVersion,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  expect(await screen.findByRole("heading", { name: "Move this session to another machine" })).toBeTruthy()
})

it("moves the session and switches to the target machine", async () => {
  const { user, snapshot, studio, onTransferSession, onSelectMachine } = await openTransferDialog({
    outcome: "succeeded",
    contractVersion: sessionTransferContractVersion,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransferSession).toHaveBeenCalledWith({
    contractVersion: sessionTransferContractVersion,
    intentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sessionId: snapshot.activeSessionId,
    targetMachineId: studio.id,
    method: "git-bundle",
  })
  expect(onSelectMachine).toHaveBeenCalledWith(studio.id)
})

it("records the move in the thread as a receipt", async () => {
  const { user } = await openTransferDialog({
    outcome: "succeeded",
    contractVersion: sessionTransferContractVersion,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const receipt = await screen.findByTestId("session-transfer-receipt")
  expect(receipt.textContent).toContain("Session moved to studio")
  expect(receipt.textContent).toContain("cccccccc")
  expect(receipt.textContent).toContain("recovery checkpoint")
})

it("records a refusal with the reason the daemon gave", async () => {
  const { user } = await openTransferDialog({
    outcome: "refused",
    reason: "session-turn-active",
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const receipt = await screen.findByTestId("session-transfer-receipt")
  expect(receipt.textContent).toContain("Session did not move to studio")
  expect(receipt.textContent)
    .toContain("This session is mid turn, so it cannot move until the turn settles")
})

it("records a failed move without inventing a reason", async () => {
  const { user, snapshot, onSelectMachine } = await openTransferDialog({
    outcome: "incomplete",
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    state: "failed",
    reason: "persistence-failed",
    recoveryAction: "none",
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  const receipt = await screen.findByTestId("session-transfer-receipt")
  expect(receipt.textContent).toContain("Session did not move to studio")
  expect(receipt.textContent).toContain(`stayed on ${snapshot.machine.name}`)
  expect(onSelectMachine).not.toHaveBeenCalled()
})

it("offers no move where nothing can carry it out", async () => {
  const snapshot = movableSnapshot()
  const [local, studio] = fleetFor(snapshot)
  const user = userEvent.setup()
  render(
    <ThreadWithDrawerMove
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      fleet={[local, studio].map((machine) => ({ kind: "machine" as const, machine }))}
      currentMachineId={local.id}
      {...handlers}
    />,
  )

  await user.click(screen.getByRole("button", { name: "Move to another machine" }))

  expect(screen.queryByText("Move this session to")).toBeNull()
})
