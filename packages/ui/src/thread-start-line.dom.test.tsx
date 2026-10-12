import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

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

// D4: the header clock, from the snapshot's turns (ruling Q401). The header
// describes the session's latest turn; with no timing it keeps the plain
// start above and invents no duration.
const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
const clockAt = (iso: string) => hm.format(new Date(iso))

function withTurn(turn: Partial<NonNullable<WorkspaceSnapshot["turns"]>[number]>, running = false): WorkspaceSnapshot {
  const snapshot = workspace()
  const sessionId = snapshot.activeSessionId!
  snapshot.turns = [
    { id: "turn-old", sessionId, ordinal: 1, startedAt: "2026-09-08T08:00:00.000Z", completedAt: "2026-09-08T08:01:00.000Z", status: "completed" },
    { id: "turn-2", sessionId, ordinal: 2, startedAt: "2026-09-08T09:00:00.000Z", status: "pending", ...turn },
  ]
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  if (running) session.activeTurnId = "provider-turn-2"
  else delete session.activeTurnId
  return snapshot
}

describe("the header clock", () => {
  it("gives a finished turn its duration", () => {
    render(<Thread snapshot={withTurn({ completedAt: "2026-09-08T09:04:18.000Z", status: "completed" })} connected queued={undefined} {...handlers} />)
    expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · 4m 18s`)).toBeTruthy()
  })

  it("says when a stopped turn stopped", () => {
    render(<Thread snapshot={withTurn({ completedAt: "2026-09-08T09:01:00.000Z", status: "interrupted" })} connected queued={undefined} {...handlers} />)
    expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · stopped ${clockAt("2026-09-08T09:01:00.000Z")}`)).toBeTruthy()
  })

  it("runs while the turn runs, and ticks", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    try {
      vi.setSystemTime(new Date("2026-09-08T09:01:09.000Z"))
      render(<Thread snapshot={withTurn({}, true)} connected queued={undefined} {...handlers} />)
      expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · running 1m 09s`)).toBeTruthy()
      act(() => { vi.advanceTimersByTime(2_000) })
      expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · running 1m 11s`)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("runs from the session's own start when no thread row links the running turn yet", () => {
    const snapshot = withTurn({ completedAt: "2026-09-08T09:04:18.000Z", status: "completed" }, true)
    const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!
    session.activeTurnStartedAt = "2026-09-08T10:00:00.000Z"
    render(<Thread snapshot={snapshot} connected queued={undefined} {...handlers} />)
    expect(screen.getByText(new RegExp(`^started ${clockAt("2026-09-08T10:00:00.000Z")} · running `, "u"))).toBeTruthy()
  })

  it("does not show the last turn's duration while a newer turn runs with no known start", () => {
    render(<Thread snapshot={withTurn({ completedAt: "2026-09-08T09:04:18.000Z", status: "completed" }, true)} connected queued={undefined} {...handlers} />)
    expect(screen.queryByText(/4m 18s/u)).toBeNull()
    expect(screen.getByText(/^started \d{2}:\d{2}$/u)).toBeTruthy()
  })

  it("stalls at the moment the daemon was lost", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    try {
      vi.setSystemTime(new Date("2026-09-08T09:06:00.000Z"))
      const snapshot = withTurn({}, true)
      const { rerender } = render(<Thread snapshot={snapshot} connected queued={undefined} {...handlers} />)
      rerender(<Thread snapshot={snapshot} connected={false} queued={undefined} {...handlers} />)
      expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · stalled at ${clockAt("2026-09-08T09:06:00.000Z")}`)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stalls with no time when the thread opened with the daemon already lost", () => {
    render(<Thread snapshot={withTurn({}, true)} connected={false} queued={undefined} {...handlers} />)
    expect(screen.getByText(`started ${clockAt("2026-09-08T09:00:00.000Z")} · stalled`)).toBeTruthy()
  })
})
