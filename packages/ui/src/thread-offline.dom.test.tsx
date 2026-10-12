import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { WorkspaceConnectionProvider } from "./connection-status"
import type { QueuedMessage } from "./turn-queue"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type SendSpy = (sessionId: string, prompt: string) => Promise<void>

function idle(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  delete (active as { activeTurnId?: string }).activeTurnId
  snapshot.approvals = []
  return snapshot
}

function OfflineThread({ connected, onSend, onReconnect = vi.fn(), snapshot = idle() }: {
  connected: boolean
  onSend: SendSpy
  onReconnect?: () => void
  snapshot?: WorkspaceSnapshot
}) {
  const [queued, setQueued] = useState<QueuedMessage>()
  return (
    <WorkspaceConnectionProvider
      connected={connected}
      reconnecting={false}
      authenticationRequired={null}
      protocolError={null}
      connectionError=""
      machineName={snapshot.machine.name}
      onReconnect={onReconnect}
    >
      <Thread
        snapshot={snapshot}
        connected={connected}
        surface="desktop"
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
    </WorkspaceConnectionProvider>
  )
}

const field = () => screen.getByLabelText("Message") as HTMLTextAreaElement
const composerCard = () => document.querySelector<HTMLElement>("[data-workspace-composer]")!

// The design puts the banner at the top of the thread column, where the
// thread it speaks for is.
it("draws the lost-daemon banner at the top of the thread", () => {
  render(<OfflineThread connected={false} onSend={vi.fn<SendSpy>(async () => {})} />)

  const banner = screen.getByText("Lost the daemon on macbook-pro-m3").closest("[role=status]")!
  const thread = screen.getByRole("main")
  expect(thread.contains(banner)).toBe(true)
  expect(thread.firstElementChild).toBe(banner)
})

it("draws no banner while the daemon answers", () => {
  render(<OfflineThread connected onSend={vi.fn<SendSpy>(async () => {})} />)

  expect(screen.queryByText(/Lost the daemon/u)).toBeNull()
  expect(screen.queryByRole("button", { name: /^Reconnect to/u })).toBeNull()
})

it("offers to reconnect to the machine and says why review and move wait for it", async () => {
  const onReconnect = vi.fn()
  render(<OfflineThread connected={false} onSend={vi.fn<SendSpy>(async () => {})} onReconnect={onReconnect} />)

  expect(screen.getByText("Reviewing and moving this session both need the daemon, since the worktree only exists on that machine.")).toBeTruthy()
  await userEvent.click(screen.getByRole("button", { name: "Reconnect to macbook-pro-m3" }))
  expect(onReconnect).toHaveBeenCalledOnce()
})

it("dims the composer and leaves its field and chips dead while offline", () => {
  render(<OfflineThread connected={false} onSend={vi.fn<SendSpy>(async () => {})} />)

  expect(composerCard().className.split(" ")).toContain("opacity-50")
  expect(field().disabled).toBe(true)
  // The card carries the .5. The shared Textarea's disabled panel and second
  // dimming are not drawn: the design's field has no box of its own.
  expect(field().className.split(" ")).toEqual(expect.arrayContaining(["disabled:bg-transparent", "disabled:opacity-100"]))
  expect(field().getAttribute("placeholder")).toBe("Cannot send, the daemon is not answering")
  const card = within(composerCard())
  for (const name of ["Attach", /^Mode: /u, "Expand prompt editor", "Send message"]) {
    expect((card.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
  }
  const model = card.getByRole("button", { name: /·/u }) as HTMLButtonElement
  expect(model.disabled).toBe(true)
})

it("keeps the composer live while the daemon answers", () => {
  render(<OfflineThread connected onSend={vi.fn<SendSpy>(async () => {})} />)

  expect(composerCard().className.split(" ")).not.toContain("opacity-50")
  expect(field().disabled).toBe(false)
})

// The design draws the placeholder in the faint tone, not the muted one the
// shared Textarea brings.
it("draws the placeholder faint", () => {
  render(<OfflineThread connected={false} onSend={vi.fn<SendSpy>(async () => {})} />)

  expect(field().className.split(" ")).toContain("placeholder:text-faint")
})

// A key press reaches a disabled field's handler in some paths (a field that
// lost its connection while focused), so the send itself refuses too.
it("sends nothing from the field while offline", () => {
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<OfflineThread connected onSend={onSend} />)
  fireEvent.change(field(), { target: { value: "Do the work" } })
  rerender(<OfflineThread connected={false} onSend={onSend} />)

  fireEvent.keyDown(field(), { key: "Enter" })

  expect(onSend).not.toHaveBeenCalled()
  expect(field().value).toBe("Do the work")
})

// The larger editor is the same draft, and its send is the composer's send.
it("refuses a send from the prompt editor once the daemon is lost", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn<SendSpy>(async () => {})
  const { rerender } = render(<OfflineThread connected onSend={onSend} />)
  await user.type(field(), "Do the work")
  await user.click(screen.getByRole("button", { name: "Expand prompt editor" }))
  rerender(<OfflineThread connected={false} onSend={onSend} />)

  const dialog = screen.getByRole("dialog")
  const send = within(dialog).getByRole("button", { name: /^Send/u }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Enter", metaKey: true })
  fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Enter", ctrlKey: true })
  expect(onSend).not.toHaveBeenCalled()
})
