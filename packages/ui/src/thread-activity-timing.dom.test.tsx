import { demoWorkspace, type ThreadItem, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

// D7: the activity row says how long its turn worked, from the snapshot's
// turns, and only the turn's last row says it.
function finishedTurn(turn: Partial<NonNullable<WorkspaceSnapshot["turns"]>[number]>): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.activeSessionId!
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  delete session.activeTurnId
  const tool = (id: string): ThreadItem => ({
    id, sessionId, turnId: "turn-1", kind: "tool", tool: "command", status: "completed", title: `pnpm ${id}`, createdAt: "2026-09-08T09:00:30.000Z",
  })
  snapshot.thread = [
    { id: "user-1", sessionId, turnId: "turn-1", kind: "user", body: "Run the suite", createdAt: "2026-09-08T09:00:00.000Z" },
    tool("lint"),
    { id: "assistant-1", sessionId, turnId: "turn-1", kind: "assistant", body: "Lint is clean.", createdAt: "2026-09-08T09:01:00.000Z" },
    tool("test"),
    tool("build"),
  ]
  snapshot.turns = [{ id: "turn-1", sessionId, ordinal: 1, startedAt: "2026-09-08T09:00:00.000Z", completedAt: "2026-09-08T09:04:18.000Z", status: "completed", ...turn }]
  return snapshot
}

it("says how long the turn worked on its last row", () => {
  render(<Thread snapshot={finishedTurn({})} connected queued={undefined} {...handlers} />)
  expect(screen.getByRole("button", { name: /^Worked for 4m 18s, show the steps/u })).toBeTruthy()
})

it("keeps the count on an earlier row of the same turn", () => {
  render(<Thread snapshot={finishedTurn({})} connected queued={undefined} {...handlers} />)
  expect(screen.getByRole("button", { name: /^1 tool call\b/u })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: /Worked for/u })).toHaveLength(1)
})

it("says Stopped for a turn that stopped", () => {
  render(<Thread snapshot={finishedTurn({ status: "interrupted", completedAt: "2026-09-08T09:02:00.000Z" })} connected queued={undefined} {...handlers} />)
  expect(screen.getByRole("button", { name: /^Stopped/u })).toBeTruthy()
})

it("keeps the count when the snapshot carries no timing", () => {
  const snapshot = finishedTurn({})
  delete snapshot.turns
  render(<Thread snapshot={snapshot} connected queued={undefined} {...handlers} />)
  expect(screen.getByRole("button", { name: /^2 tool calls/u })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Worked for/u })).toBeNull()
})

// The design's offline state: a turn this client can no longer see is not
// Working, and a call it last saw running has no result anyone saw.
it("does not say Working while the daemon is lost", async () => {
  const snapshot = finishedTurn({ status: "pending" })
  delete snapshot.turns![0]!.completedAt
  const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!
  session.activeTurnId = "provider-turn"
  const last = snapshot.thread.at(-1) as Extract<ThreadItem, { kind: "tool" }>
  last.status = "running"
  render(<Thread snapshot={snapshot} connected={false} queued={undefined} {...handlers} />)
  expect(screen.queryByRole("button", { name: /^Working/u })).toBeNull()
  expect(document.querySelectorAll(".sweep-bar")).toHaveLength(0)
  const row = screen.getByRole("button", { name: /^2 tool calls/u })
  await userEvent.setup().click(row)
  const dot = screen.getByText("pnpm build").closest("li")!.querySelector("[data-status-dot]")!
  expect(dot.className.split(/\s+/u)).toContain("bg-faint")
})
