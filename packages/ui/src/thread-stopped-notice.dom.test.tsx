import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function withTurn(turnId: string | undefined): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (turnId) active.activeTurnId = turnId
  else delete (active as { activeTurnId?: string }).activeTurnId
  return snapshot
}

// Ruled Q361 A: the wire has no paused state, and session.pause ends the
// running turn. After this client stops a turn, the thread says that, and that
// the next send starts the next turn, rather than the design's "Paused".
it("says the turn ended after this client stops it, until another turn starts", async () => {
  const user = userEvent.setup()
  const onPauseSession = vi.fn(async () => {})
  const thread = (snapshot: WorkspaceSnapshot) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={onPauseSession}
    />
  )
  const { rerender } = render(thread(withTurn("turn-1")))
  expect(screen.queryByText(/^Stopped\./u)).toBeNull()

  await user.click(screen.getByRole("button", { name: "Stop the agent" }))
  expect(onPauseSession).toHaveBeenCalledOnce()
  // The stop lands at the next tool boundary; until the turn has ended the
  // thread does not say it has.
  expect(screen.queryByText(/^Stopped\./u)).toBeNull()

  rerender(thread(withTurn(undefined)))
  const notice = screen.getByRole("status", { name: "Session stopped" })
  expect(notice.textContent).toContain("Stopped. The turn ended. The next message you send starts the next turn.")
  expect(notice.textContent).toMatch(/stopped \d{2}:\d{2} · from this client/u)
  expect(notice.textContent).not.toMatch(/Paused|Resume/u)

  rerender(thread(withTurn("turn-2")))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
  rerender(thread(withTurn(undefined)))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
})

it("says nothing when the stop was refused", async () => {
  const user = userEvent.setup()
  const snapshot = withTurn("turn-1")
  const props = {
    onQueuedChange: vi.fn(),
    connected: true,
    onResolve: vi.fn(async () => {}),
    onSetRuntime: vi.fn(async () => {}),
    onForkSession: vi.fn(async () => {}),
    onListModels: vi.fn(async () => []),
    onNewSession: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCheckpoint: vi.fn(async () => {}),
    onRestoreCheckpoint: vi.fn(async () => {}),
    onPauseSession: vi.fn(async () => { throw new Error("Session is not running") }),
  }
  const { rerender } = render(<Thread {...props} snapshot={snapshot} />)
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))
  rerender(<Thread {...props} snapshot={withTurn(undefined)} />)
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
})
