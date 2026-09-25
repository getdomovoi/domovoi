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

function workspace(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.activeSessionId!
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.title = "webhook idempotency"
  session.workspacePath = "/Users/fetzy/.domovoi/worktrees/wt-billing-idem"
  snapshot.project = { ...snapshot.project!, name: "acme-api", branch: "main" }
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

// v2 names the session in the command palette pill and opens the thread with
// one mono rule that scrolls away. A fixed banner repeating the worktree path
// on every turn is not in the design.
it("opens the thread with the repository, branch and worktree", () => {
  render(<Thread snapshot={workspace()} connected queued={undefined} {...handlers} />)

  expect(screen.getByText("acme-api · main · wt-billing-idem")).toBeTruthy()
})

it("does not repeat the session title in a fixed banner", () => {
  render(<Thread snapshot={workspace()} connected queued={undefined} {...handlers} />)

  expect(screen.queryByRole("heading", { name: "webhook idempotency" })).toBeNull()
})

it("says when the session started rather than estimating a duration", () => {
  render(<Thread snapshot={workspace()} connected queued={undefined} {...handlers} />)

  expect(screen.getByText(/^started \d{2}:\d{2}$/u)).toBeTruthy()
})
