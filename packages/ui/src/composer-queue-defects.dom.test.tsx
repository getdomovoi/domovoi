import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"
import { heldAfterStop, shouldRelease, type QueuedMessage } from "./turn-queue"

afterEach(cleanup)

type SendSpy = (sessionId: string, prompt: string, selection?: unknown) => Promise<void>

function withTurn(running: boolean, activeSessionId?: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  if (activeSessionId) snapshot.activeSessionId = activeSessionId
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (running) active.activeTurnId = "turn-1"
  else delete (active as { activeTurnId?: string }).activeTurnId
  return snapshot
}

// The queue lives above Thread in the real shell, so the harness holds it too.
// Anything less would test a component that cannot lose its queue because the
// test never unmounts it.
function Harness({
  snapshot,
  onSend,
  emergencyStopPending = false,
}: {
  snapshot: WorkspaceSnapshot
  onSend: SendSpy
  emergencyStopPending?: boolean
}) {
  const [queued, setQueued] = useState<QueuedMessage>()
  return (
    <Thread
      key={snapshot.activeSessionId ?? "none"}
      snapshot={snapshot}
      connected
      emergencyStopPending={emergencyStopPending}
      queued={queued}
      onQueuedChange={setQueued}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={onSend}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      onArchiveSession={vi.fn(async () => {})}
    />
  )
}

async function queueMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Message"), text)
  await user.click(screen.getByRole("button", { name: "Send message" }))
}

it("keeps a refused message and does not retry it on its own", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => { throw new Error("Provider refused the turn") })
  const { rerender } = render(<Harness snapshot={withTurn(true)} onSend={onSend} />)
  await queueMessage(user, "also update the changelog")

  rerender(<Harness snapshot={withTurn(false)} onSend={onSend} />)

  await waitFor(() => expect(onSend).toHaveBeenCalled())
  // The refusal put the message back. Bounded on purpose: a queue that
  // re-queues itself as waiting is retried by the release effect forever.
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(screen.getByText("also update the changelog")).toBeTruthy()
  expect(screen.getByText(/Held because sending failed/)).toBeTruthy()
})

it("sends a held message only when a person asks for it", async () => {
  const user = userEvent.setup()
  let fail = true
  const onSend = vi.fn<SendSpy>(async () => {
    if (fail) { fail = false; throw new Error("Provider refused the turn") }
  })
  const { rerender } = render(<Harness snapshot={withTurn(true)} onSend={onSend} />)
  await queueMessage(user, "run the migration")
  rerender(<Harness snapshot={withTurn(false)} onSend={onSend} />)
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

  await user.click(screen.getByRole("button", { name: "Send" }))

  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
  expect(onSend.mock.calls[1]?.[1]).toBe("run the migration")
})

it("does not erase a newer draft when the queued message goes", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<Harness snapshot={withTurn(true)} onSend={onSend} />)
  await queueMessage(user, "queued text")
  await user.type(screen.getByLabelText("Message"), "a newer draft")

  rerender(<Harness snapshot={withTurn(false)} onSend={onSend} />)

  await waitFor(() => expect(onSend.mock.calls[0]?.[1]).toBe("queued text"))
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("a newer draft")
})

it("holds the queue through an emergency stop rather than flushing it", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<Harness snapshot={withTurn(true)} onSend={onSend} />)
  await queueMessage(user, "run the migration")

  rerender(<Harness snapshot={withTurn(false)} onSend={onSend} emergencyStopPending />)

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByText("run the migration")).toBeTruthy()
})

it("never releases a queued message into a different session", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const first = withTurn(true)
  const other = first.sessions.find((session) => session.id !== first.activeSessionId)!
  const { rerender } = render(<Harness snapshot={first} onSend={onSend} />)
  await queueMessage(user, "for the first session")

  rerender(<Harness snapshot={withTurn(false, other.id)} onSend={onSend} />)

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.queryByText("for the first session")).toBeNull()
})

it("still has the queued message after leaving the session and coming back", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const first = withTurn(true)
  const firstId = first.activeSessionId!
  const other = first.sessions.find((session) => session.id !== firstId)!
  const { rerender } = render(<Harness snapshot={first} onSend={onSend} />)
  await queueMessage(user, "for the first session")

  // Thread is keyed by session, so this unmounts it. The queue must not live
  // inside the view that navigation throws away.
  rerender(<Harness snapshot={withTurn(true, other.id)} onSend={onSend} />)
  expect(screen.queryByText("for the first session")).toBeNull()

  rerender(<Harness snapshot={withTurn(true, firstId)} onSend={onSend} />)
  expect(screen.getByText("for the first session")).toBeTruthy()

  rerender(<Harness snapshot={withTurn(false, firstId)} onSend={onSend} />)
  await waitFor(() => expect(onSend.mock.calls[0]?.[1]).toBe("for the first session"))
})

it("holds queued work when a stop ends the turn", () => {
  const waiting: QueuedMessage = { sessionId: "s1", text: "run it", state: "waiting" }
  const held = heldAfterStop(waiting)!
  expect(held.state).toBe("held")
  // The stop removes activeTurnId, so without this the ordinary boundary would
  // read as permission to resume the work the stop just ended.
  expect(shouldRelease({ queued: held, sessionId: "s1", turnRunning: false, busy: false })).toBe(false)
  expect(shouldRelease({ queued: waiting, sessionId: "s1", turnRunning: false, busy: false })).toBe(true)
})
