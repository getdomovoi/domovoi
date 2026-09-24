import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { CheckpointFork } from "./workspace-shell"

afterEach(cleanup)

// server.ts:6324 gives the fork candidate a checkpoint and a system note, not a
// replayed source conversation. The design system's own pattern for a handoff
// ships both halves together, what it carries and what it does not, so the
// confirm has to say both rather than let the label promise the conversation.
it("says what the fork carries and what it does not before forking", async () => {
  const user = userEvent.setup()
  render(<CheckpointFork checkpointId="checkpoint-7f23" label="before migration" disabled={false} onFork={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: "Fork from here" }))

  const copy = screen.getByRole("alertdialog").textContent ?? ""
  expect(copy).toContain("before migration")
  expect(copy).toContain("worktree")
  expect(copy).toContain("not replayed")
})

it("forks from the checkpoint the row names", async () => {
  const user = userEvent.setup()
  const onFork = vi.fn()
  render(<CheckpointFork checkpointId="checkpoint-7f23" label="before migration" disabled={false} onFork={onFork} />)

  await user.click(screen.getByRole("button", { name: "Fork from here" }))
  await user.click(screen.getByRole("button", { name: "Fork session" }))

  expect(onFork).toHaveBeenCalledWith("checkpoint-7f23")
})

it("offers nothing to click while forking is held shut", async () => {
  render(<CheckpointFork checkpointId="checkpoint-7f23" label="before migration" disabled onFork={vi.fn()} />)

  expect(screen.getByRole("button", { name: "Fork from here" }).hasAttribute("disabled")).toBe(true)
})

// Fork belongs on a checkpoint row and nowhere else. A tool row names no point
// you can resume from, and offering it there implies a capability the protocol
// does not have.
it("offers fork on a checkpoint row and not on a tool row", async () => {
  const { HistoryPanel } = await import("./workspace-shell")
  const page = {
    sessionId: "session-billing",
    hasMore: false,
    items: [
      {
        id: "thread:checkpoint-7f23",
        sourceId: "checkpoint-7f23",
        sessionId: "session-billing",
        createdAt: "2026-09-08T12:51:00.000Z",
        category: "checkpoints" as const,
        label: "7f23abcd · before migration",
        commit: "7f23abcd" + "0".repeat(32),
      },
      {
        id: "thread:tool-1",
        sourceId: "tool-1",
        sessionId: "session-billing",
        createdAt: "2026-09-08T12:52:00.000Z",
        category: "tools" as const,
        tool: "command" as const,
        status: "completed" as const,
        title: "pnpm test",
      },
    ],
  }
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => page)}
      onRestoreCheckpoint={vi.fn()}
      onForkCheckpoint={vi.fn()}
    />,
  )
  expect(await screen.findAllByRole("button", { name: "Fork from here" })).toHaveLength(1)
})

// Fork and restore are two decisions about the same row, not one control with
// two buttons. A client that offers fork and not restore still offers fork.
it("offers fork on a checkpoint row when the shell supplies no restore", async () => {
  const { HistoryPanel } = await import("./workspace-shell")
  const page = {
    sessionId: "session-billing",
    hasMore: false,
    items: [{
      id: "thread:checkpoint-7f23",
      sourceId: "checkpoint-7f23",
      sessionId: "session-billing",
      createdAt: "2026-09-08T12:51:00.000Z",
      category: "checkpoints" as const,
      label: "7f23abcd · before migration",
      commit: "7f23abcd" + "0".repeat(32),
    }],
  }
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => page)}
      onForkCheckpoint={vi.fn()}
    />,
  )
  expect(await screen.findAllByRole("button", { name: "Fork from here" })).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Restore worktree" })).toBeNull()
})

// A checkpoint with no commit names no state to branch from, so neither
// decision is offered on it.
it("offers neither decision on a checkpoint with no commit", async () => {
  const { HistoryPanel } = await import("./workspace-shell")
  const page = {
    sessionId: "session-billing",
    hasMore: false,
    items: [{
      id: "thread:checkpoint-bare",
      sourceId: "checkpoint-bare",
      sessionId: "session-billing",
      createdAt: "2026-09-08T12:51:00.000Z",
      category: "checkpoints" as const,
      label: "before migration",
    }],
  }
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => page)}
      onRestoreCheckpoint={vi.fn()}
      onForkCheckpoint={vi.fn()}
    />,
  )
  // The row has to be drawn first, or the absence checks below pass on a
  // panel that has not loaded yet.
  expect(await screen.findByText("Checkpoint: before migration")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Restore worktree" })).toBeNull()
})
