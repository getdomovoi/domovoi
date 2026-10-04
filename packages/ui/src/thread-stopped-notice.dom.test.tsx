import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

// The daemon answers session.pause successfully whether or not the interrupt
// worked, and records which in the thread: "Paused by <client>." when the turn
// ended, "Pause failed for <client>." when it did not. A daemon that names the
// asking connection puts its id on the row; an older daemon does not.
function withTurn(
  turnId: string | undefined,
  pauseRow?: "paused" | "failed",
  client = "desktop",
  connectionId?: string,
): WorkspaceSnapshot {
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
      ...(connectionId === undefined ? {} : { connectionId }),
    })
  }
  return snapshot
}

const thisConnection = "11111111-1111-4111-8111-111111111111"
const otherConnection = "22222222-2222-4222-8222-222222222222"

function renderStoppable(onPauseSession = vi.fn(async () => {}), connectionId?: string | null) {
  const thread = (snapshot: WorkspaceSnapshot) => (
    <Thread
      {...(connectionId === undefined ? {} : { connectionId })}
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

// The daemon answers a pause of an already idle session as a success without
// writing a row, so a pause another client made between this click and the
// daemon's answer is the new row this client then finds. A row that names no
// connection cannot say whose pause ended the turn.
it("does not call the pause its own, since another client's pause may be the row", async () => {
  const user = userEvent.setup()
  const { rerender } = renderStoppable()
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))

  rerender(withTurn(undefined, "paused", "web"))
  const notice = screen.getByRole("status", { name: "Session stopped" })
  expect(notice.textContent).toContain("Stopped. The turn ended. The next message you send starts the next turn.")
  expect(notice.textContent).not.toContain("from this client")
})

// Ruled Q427 A: the daemon puts the asking connection's id on the pause row,
// so the notice says the stop came from this client when, and only when, the
// row it found names the connection this client holds now.
async function stopThenRecord(clientConnection: string | null | undefined, rowConnection: string | undefined) {
  const user = userEvent.setup()
  const { rerender } = renderStoppable(vi.fn(async () => {}), clientConnection)
  await user.click(screen.getByRole("button", { name: "Stop the agent" }))
  rerender(withTurn(undefined, "paused", "desktop", rowConnection))
  return screen.getByRole("status", { name: "Session stopped" })
}

it("says the stop came from this client when the pause row names this connection", async () => {
  const notice = await stopThenRecord(thisConnection, thisConnection)
  expect(notice.textContent).toContain("Stopped. The turn ended. The next message you send starts the next turn.")
  expect(notice.textContent).toMatch(/stopped \d{2}:\d{2} · from this client$/u)
})

it("does not say this client when the pause row names another connection", async () => {
  const notice = await stopThenRecord(thisConnection, otherConnection)
  expect(notice.textContent).toMatch(/stopped \d{2}:\d{2}$/u)
  expect(notice.textContent).not.toContain("from this client")
})

it("does not say this client when the pause row names no connection, as an older daemon writes it", async () => {
  const notice = await stopThenRecord(thisConnection, undefined)
  expect(notice.textContent).toMatch(/stopped \d{2}:\d{2}$/u)
  expect(notice.textContent).not.toContain("from this client")
})

it("does not say this client when the client holds no connection id", async () => {
  for (const clientConnection of [null, undefined]) {
    const notice = await stopThenRecord(clientConnection, thisConnection)
    expect(notice.textContent).toMatch(/stopped \d{2}:\d{2}$/u)
    expect(notice.textContent).not.toContain("from this client")
    cleanup()
  }
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
