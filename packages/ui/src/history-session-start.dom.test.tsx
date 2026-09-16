import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

afterEach(cleanup)

const checkpoint = (over: Record<string, unknown>) => ({
  id: "thread:checkpoint-one",
  sourceId: "checkpoint-one",
  sessionId: "session-billing",
  createdAt: "2026-09-10T13:52:00.000Z",
  category: "checkpoints" as const,
  label: "8f3c1de · session start",
  commit: "8f3c1de5" + "0".repeat(32),
  ...over,
})

async function panel(items: ReturnType<typeof checkpoint>[]) {
  const { HistoryPanel } = await import("./workspace-shell")
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      worktreeName="wt-billing"
      onLoad={vi.fn(async () => ({ sessionId: "session-billing", hasMore: false, items }))}
      onRestoreCheckpoint={vi.fn()}
      onForkCheckpoint={vi.fn()}
    />,
  )
  // The load runs through the request controller and a few promise hops; a
  // fixed wait raced it on a loaded Windows runner. Wait for the row itself.
  await screen.findByTestId("history-row")
}

// CX5 typed the reason a checkpoint exists. The session-start row is the base
// commit of the worktree, so forking from it produces a session identical to
// starting a new one, and the design draws it with fork absent rather than
// disabled. Restore stays: going back to it is exactly what it is for.
it("offers restore but not fork on the session-start checkpoint", async () => {
  await panel([checkpoint({ reason: "session-start" })])

  expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull()
  expect(screen.getByRole("button", { name: "Restore worktree" })).toBeTruthy()
})

it("says why the row has nothing behind it rather than naming a commit", async () => {
  await panel([checkpoint({ reason: "session-start" })])

  expect(screen.getByTestId("history-meta").textContent)
    .toBe("session start · nothing to revert past this")
})

it("keeps fork on every other checkpoint", async () => {
  await panel([checkpoint({ reason: "manual", label: "8f3c1de · before migration" })])

  expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy()
})

// A row recorded before CX5 carries no reason at all. Absent is its own answer:
// the client cannot tell whether it was a session start, so it does not guess,
// and the row keeps the fork it has always had.
it("does not suppress fork on a legacy checkpoint with no reason", async () => {
  await panel([checkpoint({})])

  expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy()
})
