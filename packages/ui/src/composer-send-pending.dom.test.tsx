import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { sessionDraftStore } from "./session-draft"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)
afterEach(() => { for (const session of demoWorkspace.sessions) sessionDraftStore.clear(session.id) })

// A send waits on the daemon, and the request budget is 120 seconds. The person
// must not watch their own words sit in the box for that long with nothing said.
function ThreadWith({ snapshot, onSend }: {
  snapshot: WorkspaceSnapshot
  onSend: (sessionId: string, prompt: string) => Promise<void>
}) {
  return (
    <Thread
      snapshot={snapshot}
      connected
      surface="desktop"
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={onSend}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
}

// The direct send path, not the queue path: no turn may be running.
function idleWorkspace(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  if (!active) throw new Error("The demo workspace needs an active session for this test")
  delete active.activeTurnId
  return snapshot
}

function deferred() {
  let settle: { resolve: () => void; reject: (cause: Error) => void } | undefined
  const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  if (!settle) throw new Error("The promise executor did not run")
  return { promise, ...settle }
}

const field = () => screen.getByLabelText("Message") as HTMLTextAreaElement
const send = () => screen.getByLabelText("Send message")

it("empties the box the moment the person presses send", async () => {
  const person = userEvent.setup()
  const inFlight = deferred()
  render(<ThreadWith snapshot={idleWorkspace()} onSend={vi.fn(async () => inFlight.promise)} />)

  await person.type(field(), "run the migration")
  await person.click(send())

  expect(field().value).toBe("")
  inFlight.resolve()
})

it("shows the message as sending while the daemon has not answered", async () => {
  const person = userEvent.setup()
  const inFlight = deferred()
  render(<ThreadWith snapshot={idleWorkspace()} onSend={vi.fn(async () => inFlight.promise)} />)

  await person.type(field(), "run the migration")
  await person.click(send())

  const strip = screen.getByRole("status", { name: "Sending" })
  expect(strip.textContent).toContain("run the migration")
  expect(strip.textContent).toContain("sending")
  inFlight.resolve()
})

// The daemon owns the thread. The strip is a local note that the request is out,
// so once the daemon has it the strip must go rather than stand beside the real row.
it("drops the sending note once the daemon accepts the message", async () => {
  const person = userEvent.setup()
  const inFlight = deferred()
  render(<ThreadWith snapshot={idleWorkspace()} onSend={vi.fn(async () => inFlight.promise)} />)

  await person.type(field(), "run the migration")
  await person.click(send())
  expect(screen.getByRole("status", { name: "Sending" })).toBeTruthy()

  inFlight.resolve()
  await waitFor(() => expect(screen.queryByRole("status", { name: "Sending" })).toBeNull())
  expect(screen.queryAllByText("run the migration")).toHaveLength(0)
})

it("puts the words back in the box when the send is refused", async () => {
  const person = userEvent.setup()
  const inFlight = deferred()
  render(<ThreadWith snapshot={idleWorkspace()} onSend={vi.fn(async () => inFlight.promise)} />)

  await person.type(field(), "run the migration")
  await person.click(send())
  expect(field().value).toBe("")

  inFlight.reject(new Error("The daemon refused the message"))
  await waitFor(() => expect(field().value).toBe("run the migration"))
  expect(screen.queryByRole("status", { name: "Sending" })).toBeNull()
})

// Restoring the failed text over a newer thought would delete work the person
// did while they waited. The failed text is theirs, but so is the new text.
it("keeps what the person typed while the failed send was still out", async () => {
  const person = userEvent.setup()
  const inFlight = deferred()
  render(<ThreadWith snapshot={idleWorkspace()} onSend={vi.fn(async () => inFlight.promise)} />)

  await person.type(field(), "run the migration")
  await person.click(send())
  await person.type(field(), "a second thought")

  inFlight.reject(new Error("The daemon refused the message"))
  await waitFor(() => expect(screen.getByText("The daemon refused the message")).toBeTruthy())
  expect(field().value).toBe("a second thought")
})
