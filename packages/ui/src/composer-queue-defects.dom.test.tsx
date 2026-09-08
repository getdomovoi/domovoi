import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type SendSpy = (sessionId: string, prompt: string, selection?: unknown) => Promise<void>

function threadFor(snapshot: WorkspaceSnapshot, onSend: SendSpy, emergencyStopPending = false) {
  return (
    <Thread
      snapshot={snapshot}
      connected
      emergencyStopPending={emergencyStopPending}
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

function withTurn(running: boolean, activeSessionId?: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  if (activeSessionId) snapshot.activeSessionId = activeSessionId
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (running) active.activeTurnId = "turn-1"
  else delete (active as { activeTurnId?: string }).activeTurnId
  return snapshot
}

async function queueMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Message"), text)
  await user.click(screen.getByRole("button", { name: "Send message" }))
}

it("keeps the queued message when the send is refused", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => { throw new Error("Provider refused the turn") })
  const { rerender } = render(threadFor(withTurn(true), onSend))
  await queueMessage(user, "also update the changelog")

  rerender(threadFor(withTurn(false), onSend))

  await waitFor(() => expect(onSend).toHaveBeenCalled())
  // A refusal must not swallow the message.
  expect(screen.getByText("also update the changelog")).toBeTruthy()
})

it("does not erase a newer draft when the queued message goes", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(threadFor(withTurn(true), onSend))
  await queueMessage(user, "queued text")
  await user.type(screen.getByLabelText("Message"), "a newer draft")

  rerender(threadFor(withTurn(false), onSend))

  await waitFor(() => expect(onSend.mock.calls[0]?.[1]).toBe("queued text"))
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("a newer draft")
})

it("holds the queue through an emergency stop rather than flushing it", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(threadFor(withTurn(true), onSend))
  await queueMessage(user, "run the migration")

  rerender(threadFor(withTurn(false), onSend, true))

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByText("run the migration")).toBeTruthy()
})

it("never releases a queued message into a different session", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const first = withTurn(true)
  const other = first.sessions.find((session) => session.id !== first.activeSessionId)
  const { rerender } = render(threadFor(first, onSend))
  await queueMessage(user, "for the first session")

  if (other) {
    rerender(threadFor(withTurn(false, other.id), onSend))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByText("for the first session")).toBeNull()
  }
})
