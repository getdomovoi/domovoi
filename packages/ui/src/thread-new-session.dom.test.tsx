import { demoWorkspace, type PermissionMode, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function freshSession(permissionMode: PermissionMode = "ask", auto = false): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.workingPlans = []
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  // What session.create writes: a session-start checkpoint and a system row
  // naming the worktree. Nothing has run until a user or agent row appears.
  snapshot.thread = [
    ...snapshot.thread.filter((item) => item.sessionId !== snapshot.activeSessionId),
    {
      id: "checkpoint-start",
      sessionId: active.id,
      kind: "checkpoint",
      reason: "session-start",
      label: "Worktree created off main",
      commit: `8f3c1de${"0".repeat(33)}`,
      createdAt: "2026-10-02T12:00:00.000Z",
    },
    {
      id: "system-created",
      sessionId: active.id,
      kind: "system",
      body: "Created isolated worktree domovoi/wt-search-index.",
      detail: "/Users/dev/.domovoi/worktrees/wt-search-index",
      createdAt: "2026-10-02T12:00:00.000Z",
    },
  ]
  delete (active as { activeTurnId?: string }).activeTurnId
  active.state = "idle"
  active.workspacePath = "/Users/dev/.domovoi/worktrees/wt-search-index"
  active.baseCommit = `8f3c1de${"0".repeat(33)}`
  active.runtime = { ...active.runtime, permissionMode, auto }
  return snapshot
}

function renderThread(snapshot: WorkspaceSnapshot, surface: "desktop" | "web" = "desktop") {
  return render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      surface={surface}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  )
}

// Ruled Q368 A: the header, title, body and placeholder as drawn; the rows
// only from the session's permission mode and checkpoint policy; no starters,
// which need a suggestion source.
it.each(["desktop", "web"] as const)("draws Nothing has run yet on a %s session with an empty thread", (surface) => {
  renderThread(freshSession(), surface)

  const header = screen.getByRole("status", { name: "Worktree ready" })
  expect(header.textContent).toContain("Worktree ready")
  expect(header.textContent).toContain("wt-search-index at 8f3c1de")
  expect(screen.getByRole("heading", { name: "Nothing has run yet" })).toBeTruthy()
  expect(screen.getByText("The session exists, the worktree is cut, and the agent has not been given a turn. Your first message is what starts it.")).toBeTruthy()
  expect(screen.queryByText(/OR START FROM SOMETHING IT ALREADY KNOWS/iu)).toBeNull()
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder).toBe("Say what you want done in acme-api")
})

// Ask is read-only in the daemon for every provider that offers it, so it has
// no gate to allow and no checkpoint to take. What Plan and Ask hold a
// provider to is what the daemon configures for that provider.
it.each([
  ["claude-code", "plan", ["Read the repository and propose a plan. Claude's own plan mode makes no changes."]],
  ["codex", "plan", ["Read the repository and propose a plan. Commands run in a read-only sandbox, so nothing is written."]],
  ["claude-code", "ask", ["Read the repository. Edits and shell commands are refused."]],
  ["codex", "ask", ["Read the repository. Commands run in a read-only sandbox, so nothing is written."]],
  ["opencode", "ask", ["Read the repository. Edits and shell commands are refused."]],
] as const)("says what %s in %s will do first, from what the daemon enforces", (provider, mode, rows) => {
  const snapshot = freshSession(mode)
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  active.runtime = { ...active.runtime, provider }
  renderThread(snapshot)

  const list = screen.getByRole("list", { name: "What it will do first" })
  expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([...rows])
})

it.each([
  ["build", false, [
    "Write and run inside the worktree. Gates still stop it for your decision.",
    "Take a checkpoint before any command you allow, so the worktree can go back to it.",
  ]],
  ["build", true, [
    "Write and run inside the worktree, step after step without stopping. Hard gates and policy refusals still stop it.",
    "Take a checkpoint before any command you allow at a gate. Commands that Auto or a rule allows run without one.",
  ]],
] as const)("says what %s (auto %s) will do first, and nothing it will not", (mode, auto, rows) => {
  renderThread(freshSession(mode, auto))

  const list = screen.getByRole("list", { name: "What it will do first" })
  expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([...rows])
})

it("draws nothing of it once the thread has a turn, or while one is running", () => {
  const withItem = freshSession()
  withItem.thread = [{ id: "user-1", sessionId: withItem.activeSessionId!, kind: "user", body: "Start", createdAt: "2026-10-02T12:00:00.000Z" }]
  const { unmount } = renderThread(withItem)
  expect(screen.queryByRole("heading", { name: "Nothing has run yet" })).toBeNull()
  expect(screen.queryByRole("status", { name: "Worktree ready" })).toBeNull()
  unmount()

  const running = freshSession()
  running.sessions.find((session) => session.id === running.activeSessionId)!.activeTurnId = "turn-1"
  renderThread(running)
  expect(screen.queryByRole("heading", { name: "Nothing has run yet" })).toBeNull()
})

// The body says the worktree is cut. A session with no worktree has not cut
// one, so it does not get the state.
it("draws nothing of it for a session with no worktree", () => {
  const snapshot = freshSession()
  delete (snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) as { workspacePath?: string }).workspacePath
  renderThread(snapshot)
  expect(screen.queryByRole("heading", { name: "Nothing has run yet" })).toBeNull()
})
