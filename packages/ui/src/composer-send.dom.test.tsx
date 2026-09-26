import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import type { QueuedMessage } from "./turn-queue"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type SendSpy = (sessionId: string, prompt: string) => Promise<void>

function ThreadWith({ snapshot, onSend, connected = true, surface = "desktop" }: {
  snapshot: WorkspaceSnapshot
  onSend: SendSpy
  connected?: boolean
  surface?: "desktop" | "web"
}) {
  const [queued, setQueued] = useState<QueuedMessage>()
  return (
    <Thread
      snapshot={snapshot}
      connected={connected}
      surface={surface}
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
    />
  )
}

function withActiveTurn(running: boolean): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  if (running) active.activeTurnId = "turn-running"
  else delete (active as { activeTurnId?: string }).activeTurnId
  snapshot.approvals = []
  return snapshot
}

const field = () => screen.getByLabelText("Message") as HTMLTextAreaElement

// The design defines the hint in its data and draws it nowhere. A send key that
// is Enter alone, with no hint on screen, is a trap.
it("stacks the send and new-line hints in the action row", async () => {
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={vi.fn<SendSpy>(async () => {})} />)

  const row = document.querySelector("[data-workspace-composer-actions]")
  if (!row) throw new Error("The composer draws no action row")
  const hint = within(row as HTMLElement).getByRole("status")
  expect(hint.className.split(" ")).toContain("flex-col")
  expect(within(hint).getByText(/to send$/u)).toBeTruthy()
  expect(within(hint).getByText(/for a new line$/u)).toBeTruthy()
})

it("keeps provider readiness out of the signed action row", async () => {
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={vi.fn<SendSpy>(async () => {})} />)

  const row = document.querySelector("[data-workspace-composer-actions]")
  if (!row) throw new Error("The composer draws no action row")
  expect(within(row as HTMLElement).queryByText(/not ready$/u)).toBeNull()
})

it("uses the signed send and stop controls with the stop consequence", async () => {
  const user = userEvent.setup()
  render(<ThreadWith snapshot={withActiveTurn(true)} onSend={vi.fn<SendSpy>(async () => {})} />)

  const send = screen.getByRole("button", { name: "Send message" })
  expect(send.querySelector("svg.lucide-arrow-up")).toBeTruthy()
  const stop = screen.getByRole("button", { name: "Stop the agent" })
  expect(stop.querySelector("svg.lucide-square")).toBeTruthy()
  await user.hover(stop)
  expect(await screen.findByText("Ends this turn at its next tool boundary. The session, plan and worktree stay as they are.")).toBeTruthy()
})

it("opens slash commands from typed slash text without a duplicate action-row control", async () => {
  const user = userEvent.setup()
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={vi.fn<SendSpy>(async () => {})} />)

  expect(screen.queryByRole("button", { name: "Open slash commands" })).toBeNull()
  await user.type(field(), "/r")
  expect(screen.getByRole("listbox", { name: "THIS TURN" })).toBeTruthy()
})

// The old box sent on the modifier alone. With the hint drawn, the key and the
// hint would have disagreed.
it("sends on Enter and keeps Shift and Enter for a new line", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={onSend} />)

  await user.type(field(), "first")
  await user.keyboard("{Shift>}{Enter}{/Shift}")
  await user.type(field(), "second")
  expect(field().value).toBe("first\nsecond")

  await user.keyboard("{Enter}")
  expect(onSend).toHaveBeenCalledWith(demoWorkspace.activeSessionId, "first\nsecond", undefined)
})

it("names what the field is for in each state", async () => {
  const send = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<ThreadWith snapshot={withActiveTurn(false)} onSend={send} />)
  expect(field().getAttribute("placeholder")).toBe("Reply, or steer the plan")

  rerender(<ThreadWith snapshot={withActiveTurn(true)} onSend={send} />)
  expect(field().getAttribute("placeholder")).toBe("Steer it while it works")

  cleanup()
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={send} connected={false} />)
  expect(field().getAttribute("placeholder")).toBe("Cannot send, the daemon is not answering")
})

it("disables send while the daemon is not answering", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  render(<ThreadWith snapshot={withActiveTurn(false)} onSend={onSend} connected={false} />)

  await user.type(field(), "Do the work")
  const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  await user.click(send)
  expect(onSend).not.toHaveBeenCalled()
})

it("uses the signed browser placeholder while a turn is running or idle", () => {
  const send = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<ThreadWith snapshot={withActiveTurn(false)} onSend={send} surface="web" />)
  expect(field().getAttribute("placeholder")).toBe("Steer it, or queue the next message")

  rerender(<ThreadWith snapshot={withActiveTurn(true)} onSend={send} surface="web" />)
  expect(field().getAttribute("placeholder")).toBe("Steer it, or queue the next message")
})
