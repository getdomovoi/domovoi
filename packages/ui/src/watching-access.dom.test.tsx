import { demoWorkspace, providerFailureSchema, type ClientAccess } from "@getdomovoi/protocol"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState, type ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { AppBar } from "./app-bar"
import { Thread } from "./workspace-shell.js"
import type { QueuedMessage } from "./turn-queue"

afterEach(cleanup)

type ThreadProps = ComponentProps<typeof Thread>

function WatchingThread(props: Partial<ThreadProps> = {}) {
  const [queued, setQueued] = useState<QueuedMessage>()
  return (
    <Thread
      snapshot={structuredClone(demoWorkspace)}
      connected
      clientAccess="watching"
      queued={queued}
      onQueuedChange={setQueued}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      {...props}
    />
  )
}

it("renders the v2 watching titlebar state and locks titlebar mutations", () => {
  render(
    <AppBar
      snapshot={structuredClone(demoWorkspace)}
      connected
      clientAccess="watching"
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onNewSession={vi.fn()}
    />,
  )

  expect(screen.getByText("watching only")).toBeTruthy()
  expect((screen.getByRole("button", { name: "New session" }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Stop everything" }) as HTMLButtonElement).disabled).toBe(true)
})

it("keeps observation surfaces and provider failure visible while locking composer mutations", () => {
  const snapshot = structuredClone(demoWorkspace)
  const active = snapshot.sessions.find(({ id }) => id === snapshot.activeSessionId)!
  active.state = "failed"
  delete active.providerThreadId
  active.providerFailure = providerFailureSchema.parse({
    kind: "transport",
    action: "retry",
    message: "Provider connection failed",
    retryable: true,
  })

  render(<WatchingThread snapshot={snapshot} />)

  expect(screen.getByText("This device was paired to watch only.")).toBeTruthy()
  expect(screen.queryByText(/plan:/iu)).toBeNull()
  expect(screen.getByText("No sends, approvals, terminal or writes. Reads stream as normal.")).toBeTruthy()
  expect(screen.getByText("Provider connection failed")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true)
  expect(screen.queryByRole("button", { name: "Open slash commands" })).toBeNull()
  expect((screen.getByRole("button", { name: /^Mode:/u }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(true)
  const assistant = demoWorkspace.thread.find((item) => item.kind === "assistant")
  if (!assistant || assistant.kind !== "assistant") throw new Error("Fixture has no assistant output")
  expect(screen.getByText(assistant.body)).toBeTruthy()
})

it("blocks stale mutation handlers after access changes to watching", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn(async () => {})
  const onSetRuntime = vi.fn(async () => {})
  const onPauseSession = vi.fn(async () => {})
  const view = render(<WatchingThread clientAccess={"full" satisfies ClientAccess} onSend={onSend} onSetRuntime={onSetRuntime} onPauseSession={onPauseSession} />)
  const field = screen.getByLabelText("Message")
  await user.type(field, "/mode plan")

  view.rerender(<WatchingThread clientAccess="watching" onSend={onSend} onSetRuntime={onSetRuntime} onPauseSession={onPauseSession} />)
  const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement
  send.disabled = false
  fireEvent.click(send)
  fireEvent.keyDown(field, { key: "Enter" })
  const stop = screen.queryByRole("button", { name: "Stop the agent" }) as HTMLButtonElement | null
  if (stop) {
    stop.disabled = false
    fireEvent.click(stop)
  }

  expect(onSend).not.toHaveBeenCalled()
  expect(onSetRuntime).not.toHaveBeenCalled()
  expect(onPauseSession).not.toHaveBeenCalled()
})
