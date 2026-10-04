import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

// The daemon answers session.pause successfully whether or not the interrupt
// worked, and records which in the thread: "Paused by <client>." when the turn
// ended, "Pause failed for <client>." when it did not.
function withTurn(turnId: string | undefined, pauseRow?: "paused" | "failed", client = "desktop"): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (turnId) active.activeTurnId = turnId
  else delete (active as { activeTurnId?: string }).activeTurnId
  if (pauseRow) {
    snapshot.thread.push({
      id: `system-pause-${pauseRow}`,
      sessionId: active.id,
      kind: "system",
      body: pauseRow === "paused" ? `Paused by ${client}.` : `Pause failed for ${client}.`,
      createdAt: "2026-10-02T14:07:00.000Z",
    })
  }
  return snapshot
}

function renderStoppable(onPauseSession = vi.fn(async () => {})) {
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
  const view = render(thread(withTurn("turn-1")))
  return { rerender: (snapshot: WorkspaceSnapshot) => view.rerender(thread(snapshot)), onPauseSession }
}

// Ruled Q361 A: the wire has no paused state, and session.pause ends the
// running turn. After this client stops a turn and the daemon records the
// pause, the thread says the turn ended and the next send starts the next one.
it("says the turn ended once the daemon records the pause, until another turn starts", async () => {
  const user = userEvent.setup()
  const { rerender, onPauseSession } = renderStoppable()
  expect(screen.queryByText(/^Stopped\./u)).toBeNull()

  await user.click(screen.getByRole("button", { name: "Stop the agent" }))
  expect(onPauseSession).toHaveBeenCalledOnce()
  // The answer alone is not the pause: until the daemon records it, the
  // thread does not say the turn ended.
  expect(screen.queryByText(/^Stopped\./u)).toBeNull()

  rerender(withTurn(undefined, "paused"))
  const notice = screen.getByRole("status", { name: "Session stopped" })
  expect(notice.textContent).toContain("Stopped. The turn ended. The next message you send starts the next turn.")
  expect(notice.textContent).toMatch(/stopped \d{2}:\d{2}$/u)
  expect(notice.textContent).not.toMatch(/Paused|Resume/u)

  rerender(withTurn("turn-2", "paused"))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
  rerender(withTurn(undefined, "paused"))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
})

// The pause row names only a client kind, and the daemon answers a pause of an
// already idle session as a success without writing one. A pause another
// client made between this click and the daemon's answer is the new row this
// client then finds, so the notice cannot say whose pause ended the turn.
it("does not call the pause its own, since another client's pause may be the row", async () => {
  const user = userEvent.setup()
  const { rerender } = renderStoppable()
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))

  rerender(withTurn(undefined, "paused", "web"))
  const notice = screen.getByRole("status", { name: "Session stopped" })
  expect(notice.textContent).toContain("Stopped. The turn ended. The next message you send starts the next turn.")
  expect(notice.textContent).not.toContain("from this client")
})

it("says nothing when the daemon records that the pause failed, or records nothing", async () => {
  const user = userEvent.setup()
  const { rerender } = renderStoppable()
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))

  rerender(withTurn("turn-1", "failed"))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
  rerender(withTurn(undefined))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
})

it("says nothing when the stop was refused", async () => {
  const user = userEvent.setup()
  const { rerender } = renderStoppable(vi.fn(async () => { throw new Error("Session is not running") }))
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))
  rerender(withTurn(undefined, "paused"))
  expect(screen.queryByRole("status", { name: "Session stopped" })).toBeNull()
})
