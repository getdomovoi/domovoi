import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import type { QueuedMessage } from "./turn-queue"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type SendSpy = (sessionId: string, prompt: string) => Promise<void>

// The shell owns the queue above Thread, so the harness does too.
function ThreadWith({ snapshot, onSend }: { snapshot: WorkspaceSnapshot, onSend: SendSpy }) {
  const [queued, setQueued] = useState<QueuedMessage>()
  return (
    <Thread
      snapshot={snapshot}
      connected
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

function withActiveTurn(running: boolean): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (running) active.activeTurnId = "turn-running"
  else delete (active as { activeTurnId?: string }).activeTurnId
  // The approval would otherwise interrupt, and the gate is not what this
  // test is about.
  snapshot.approvals = []
  return snapshot
}

it("queues a message sent while a turn is running rather than sending it", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  render(<ThreadWith snapshot={withActiveTurn(true)} onSend={onSend} />)

  await user.type(screen.getByLabelText("Message"), "also update the changelog")
  await user.click(screen.getByRole("button", { name: "Send message" }))

  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByText("sends at the next turn boundary")).toBeTruthy()
  expect(screen.getByText("also update the changelog")).toBeTruthy()
})


it("keeps one queued message rather than stacking them", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  render(<ThreadWith snapshot={withActiveTurn(true)} onSend={onSend} />)

  const box = screen.getByLabelText("Message")
  await user.type(box, "first")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  await user.type(box, "second")
  await user.click(screen.getByRole("button", { name: "Send message" }))

  expect(screen.queryByText("first")).toBeNull()
  expect(screen.getByText("second")).toBeTruthy()
})
