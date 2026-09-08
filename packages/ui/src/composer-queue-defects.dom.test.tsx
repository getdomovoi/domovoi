import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"
import type { QueuedMessage } from "./turn-queue"

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
  onPauseSession = vi.fn(async () => {}),
  initialQueue,
}: {
  snapshot: WorkspaceSnapshot
  onSend: SendSpy
  emergencyStopPending?: boolean
  onPauseSession?: (sessionId: string) => Promise<void>
  initialQueue?: QueuedMessage
}) {
  const [queued, setQueued] = useState<QueuedMessage | undefined>(initialQueue)
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
      onPauseSession={onPauseSession}
      onArchiveSession={vi.fn(async () => {})}
    />
  )
}

async function queueMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Message"), text)
  await user.click(screen.getByRole("button", { name: "Send message" }))
}








it("keeps the message the person typed while a turn runs", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  render(<Harness snapshot={withTurn(true)} onSend={onSend} />)
  await queueMessage(user, "also update the changelog")

  // Queued, not sent: a message never cancels or joins a turn in flight.
  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByText("also update the changelog")).toBeTruthy()
  expect(screen.getByText(/sends at the next turn boundary/)).toBeTruthy()
})

it("holds the queue when this session is stopped", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const onPauseSession = vi.fn(async () => {})
  render(<Harness snapshot={withTurn(true)} onSend={onSend} onPauseSession={onPauseSession} />)
  await queueMessage(user, "run the migration")

  await user.click(screen.getByRole("button", { name: "Stop" }))

  await waitFor(() => expect(onPauseSession).toHaveBeenCalled())
  // The stop ends the turn, so without the hold the queue would leave at the
  // boundary the stop itself created.
  expect(screen.getByText(/Held because this session was stopped/)).toBeTruthy()
  expect(onSend).not.toHaveBeenCalled()
})

it("offers a held message back to the person rather than sending it", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const held: QueuedMessage = {
    sessionId: demoWorkspace.activeSessionId!,
    text: "run the migration",
    state: "held",
    reason: "Held because sending failed. Send it again when you want to retry.",
  }
  render(<Harness snapshot={withTurn(false)} onSend={onSend} initialQueue={held} />)

  expect(screen.getByText(/Held because sending failed/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Send" }))

  // The person moved it back to waiting; the shell is what actually sends.
  await waitFor(() => expect(screen.getByText(/sends at the next turn boundary/)).toBeTruthy())
})
