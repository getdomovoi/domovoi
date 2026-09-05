import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, type FleetMachine, type WorkspaceSnapshot } from "@getdomovoi/protocol"
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

const otherMachineId = `machine-${"b".repeat(32)}`
const transferId = `transfer-${"a".repeat(32)}`

function conflictedSnapshot(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions = snapshot.sessions.map((session) => {
    const { activeTurnId: _turn, ...rest } = session
    return {
      ...rest,
      state: "ownership-conflict" as const,
      workspacePath: "/worktrees/session",
      ownershipConflict: {
        kind: "target-session-detected" as const,
        transferId,
        otherMachineId,
        otherGeneration: 4,
        detectedAt: "2026-09-04T11:00:00.000Z",
        recoveryAction: "keep-target-session" as const,
        reason: "target-session-newer" as const,
        manifestDigest: `sha256:${"f".repeat(64)}`,
      },
    }
  })
  snapshot.activeSessionId = snapshot.sessions[0]?.id ?? null
  snapshot.approvals = []
  return snapshot
}

function studio(snapshot: WorkspaceSnapshot): FleetMachine {
  return {
    id: otherMachineId,
    label: "studio",
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "tailnet",
    capabilities: ["sessions"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true }],
    heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
    health: "healthy",
    self: false,
  }
}

function renderConflicted(onReleaseSession = vi.fn(async () => ({}))) {
  const snapshot = conflictedSnapshot()
  render(
    <Thread
      snapshot={snapshot}
      connected
      fleet={[{ kind: "machine", machine: studio(snapshot) }]}
      currentMachineId={snapshot.machine.id}
      onReleaseSession={onReleaseSession}
      {...handlers}
    />,
  )
  return { user: userEvent.setup(), snapshot, onReleaseSession }
}

it("puts the conflict and its way out in front of the operator", () => {
  renderConflicted()

  // Mounted, not rendered in isolation: a component that only passes its own
  // unit test can still be missing from the page it was built for.
  expect(screen.getByRole("alert").textContent).toContain("studio also claims this session")
  expect(screen.getByRole("button", { name: "Settle this" })).toBeTruthy()
})

it("sends the confirmation the operator agreed to, and only after they agree", async () => {
  const { user, snapshot, onReleaseSession } = renderConflicted()

  await user.click(screen.getByRole("button", { name: "Settle this" }))
  expect(onReleaseSession).not.toHaveBeenCalled()

  expect(screen.getByRole("alertdialog").textContent).toContain("nothing removes them for you")
  await user.click(screen.getByRole("button", { name: "studio keeps the session" }))

  expect(onReleaseSession).toHaveBeenCalledWith({
    sessionId: snapshot.activeSessionId,
    transferId,
    confirmation: "keep-target-session",
  })
})

it("does not offer a release the daemon cannot be asked for", () => {
  const snapshot = conflictedSnapshot()
  render(
    <Thread
      snapshot={snapshot}
      connected
      fleet={[{ kind: "machine", machine: studio(snapshot) }]}
      currentMachineId={snapshot.machine.id}
      {...handlers}
    />,
  )

  expect(screen.getByRole("button", { name: "Settle this" }).hasAttribute("disabled")).toBe(true)
})
