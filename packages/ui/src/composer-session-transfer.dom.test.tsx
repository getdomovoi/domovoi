import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, type FleetMachine, type SessionTransferResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

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
  onArchiveSession: vi.fn(async () => {}),
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
    <Thread
      snapshot={snapshot}
      connected
      fleet={[local, studio]}
      currentMachineId={local.id}
      onSelectMachine={onSelectMachine}
      onTransferSession={onTransferSession}
      onPreviewTransfer={(async () => ({
        allowed: true,
        contractVersion: 1,
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
  await user.click(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) }))
  await user.click(screen.getByRole("menuitem", { name: /move this session to studio/i }))
  return { user, snapshot, studio, onTransferSession, onSelectMachine }
}

it("opens the transfer dialog from the composer device menu", async () => {
  await openTransferDialog({
    outcome: "succeeded",
    contractVersion: 1,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  expect(screen.getByRole("heading", { name: "Move session to studio" })).toBeTruthy()
})

it("moves the session and switches to the target machine", async () => {
  const { user, snapshot, studio, onTransferSession, onSelectMachine } = await openTransferDialog({
    outcome: "succeeded",
    contractVersion: 1,
    transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownershipGeneration: 2,
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    workspacePath: "/worktrees/session",
    checkpointCommit: "c".repeat(40),
  })

  await user.click(screen.getByRole("button", { name: "Move session" }))

  expect(onTransferSession).toHaveBeenCalledWith({
    contractVersion: 1,
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
    contractVersion: 1,
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
    <Thread
      snapshot={snapshot}
      connected
      fleet={[local, studio]}
      currentMachineId={local.id}
      {...handlers}
    />,
  )

  await user.click(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) }))

  expect(screen.queryByText("Move this session to")).toBeNull()
})
