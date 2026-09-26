import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { sessionDraftStore } from "./session-draft"
import { activeThreadKey, Thread } from "./workspace-shell.js"

afterEach(cleanup)
// The store outlives a render on purpose, so each test starts from no draft.
afterEach(() => { for (const session of demoWorkspace.sessions) sessionDraftStore.clear(session.id) })

// The shell keys Thread on the session, so every switch remounts it. That reset
// is what clears the pending send and the alerts, and it must stay. What it must
// not clear is the half-written turn.
function ThreadWith({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <Thread
      key={activeThreadKey(snapshot)}
      snapshot={snapshot}
      connected
      surface="desktop"
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
}

function workspaceOn(sessionId: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.activeSessionId = sessionId
  snapshot.approvals = []
  return snapshot
}

const field = () => screen.getByLabelText("Message") as HTMLTextAreaElement

function sessionPair(): [string, string] {
  const [first, second] = demoWorkspace.sessions
  if (!first || !second) throw new Error("The demo workspace needs two sessions for this test")
  return [first.id, second.id]
}

it("gives back the unsent draft when the person returns to that session", async () => {
  const person = userEvent.setup()
  const [first, second] = sessionPair()
  const { rerender } = render(<ThreadWith snapshot={workspaceOn(first)} />)

  await person.type(field(), "half a thought")
  expect(field().value).toBe("half a thought")

  rerender(<ThreadWith snapshot={workspaceOn(second)} />)
  expect(field().value).toBe("")

  rerender(<ThreadWith snapshot={workspaceOn(first)} />)
  expect(field().value).toBe("half a thought")
})

it("keeps each session's draft to itself", async () => {
  const person = userEvent.setup()
  const [first, second] = sessionPair()
  const { rerender } = render(<ThreadWith snapshot={workspaceOn(first)} />)
  await person.type(field(), "for the first")

  rerender(<ThreadWith snapshot={workspaceOn(second)} />)
  await person.type(field(), "for the second")

  rerender(<ThreadWith snapshot={workspaceOn(first)} />)
  expect(field().value).toBe("for the first")

  rerender(<ThreadWith snapshot={workspaceOn(second)} />)
  expect(field().value).toBe("for the second")
})
