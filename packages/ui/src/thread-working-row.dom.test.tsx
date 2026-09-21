import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const handlers = {
  onQueuedChange: vi.fn(),
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

function snapshotWithRunningTurn(running: boolean): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.activeSessionId!
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  if (running) session.activeTurnId = "turn-running"
  else delete (session as { activeTurnId?: string }).activeTurnId
  snapshot.thread = [
    {
      id: "user-1",
      sessionId,
      kind: "user",
      body: "Run the suite",
      createdAt: "2026-09-08T09:00:00.000Z",
    },
  ]
  return snapshot
}

it("says the turn is working before the first tool call", () => {
  render(<Thread snapshot={snapshotWithRunningTurn(true)} connected queued={undefined} {...handlers} />)

  expect(screen.getByText("Working")).toBeTruthy()
})

it("says nothing when no turn runs", () => {
  render(<Thread snapshot={snapshotWithRunningTurn(false)} connected queued={undefined} {...handlers} />)

  expect(screen.queryByText("Working")).toBeNull()
})

// The design carries one activity row per run of tool calls, and that row is
// what says "Working". A second bare row beside it claims the turn is doing
// something other than the calls listed one row above.
it("does not add a second row beside the calls it already made", () => {
  const snapshot = snapshotWithRunningTurn(true)
  const sessionId = snapshot.activeSessionId!
  snapshot.thread = [
    ...snapshot.thread,
    {
      id: "tool-1",
      sessionId,
      kind: "tool",
      tool: "command",
      title: "src/app.ts",
      status: "completed",
      createdAt: "2026-09-08T09:00:01.000Z",
    },
  ]

  render(<Thread snapshot={snapshot} connected queued={undefined} {...handlers} />)

  expect(screen.getAllByText("Working")).toHaveLength(1)
  // The row holding the calls is the running one, so nothing in a running turn
  // reads as a finished count.
  expect(screen.queryByText(/tool calls?$/u)).toBeNull()
})
