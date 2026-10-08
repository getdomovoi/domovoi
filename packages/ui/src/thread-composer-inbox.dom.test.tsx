import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { composerInbox } from "./composer-inbox"
import { terminalOutputAttachment } from "./desktop-attachments"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function renderThread(over: Partial<ComponentProps<typeof Thread>> = {}) {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const onSend = vi.fn(async () => {})
  const props: ComponentProps<typeof Thread> = {
    snapshot,
    connected: true,
    onQueuedChange: vi.fn(),
    onResolve: vi.fn(async () => {}),
    onSetRuntime: vi.fn(async () => {}),
    onForkSession: vi.fn(async () => {}),
    onListModels: vi.fn(async () => []),
    onNewSession: vi.fn(),
    onSend,
    onCheckpoint: vi.fn(async () => {}),
    onRestoreCheckpoint: vi.fn(async () => {}),
    onPauseSession: vi.fn(async () => {}),
    ...over,
  }
  const view = render(<Thread {...props} />)
  return { onSend, view }
}

const sessionId = demoWorkspace.activeSessionId!

// Attach this output to the composer: the terminal offers by session id, and
// the open thread's composer takes it into the draft the message sends.
it("takes an attachment offered for its own session into the draft", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread()
  const output = terminalOutputAttachment("$ pnpm test\n PASS  webhooks")

  let outcome: string | undefined
  act(() => {
    outcome = composerInbox.offer(sessionId, output)
  })
  expect(outcome).toBe("attached")

  await user.type(screen.getByRole("textbox", { name: "Message" }), "Why did this pass?")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(sessionId, "Why did this pass?", undefined, [output])
})

// An offer names its session. Output from another session's terminal is
// dropped rather than landing in this draft.
it("drops an attachment offered for another session", () => {
  renderThread()
  expect(composerInbox.canReceive(sessionId)).toBe(true)

  expect(composerInbox.offer("session-not-open", terminalOutputAttachment("other"))).toBe("closed")
})

it("closes the inbox when the thread goes", () => {
  const { view } = renderThread()
  expect(composerInbox.canReceive(sessionId)).toBe(true)

  view.unmount()

  expect(composerInbox.canReceive(sessionId)).toBe(false)
})

// A watching device cannot send, so it never opens the inbox and the terminal
// does not offer an attach it could not use.
it("does not open the inbox on a watching device", () => {
  const { view } = renderThread()
  expect(composerInbox.canReceive(sessionId)).toBe(true)
  view.unmount()

  renderThread({ clientAccess: "watching" })

  expect(composerInbox.canReceive(sessionId)).toBe(false)
})

// A file the composer is still reading and output the terminal hands over can
// land in either order. Neither write may replace the other.
function slowFile() {
  let finish: (text: string) => void = () => {}
  const file = new File(["notes"], "notes.txt", { type: "text/plain" })
  Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { finish = resolve }) })
  return { file, finish: (text: string) => finish(text) }
}

it("keeps terminal output offered while a chosen file is still being read", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread()
  const { file, finish } = slowFile()
  await user.upload(screen.getByLabelText("Choose an image or file"), file)
  const output = terminalOutputAttachment("$ pnpm test\n PASS  webhooks")

  act(() => { expect(composerInbox.offer(sessionId, output)).toBe("attached") })
  await act(async () => { finish("release notes") })

  await user.type(screen.getByRole("textbox", { name: "Message" }), "Both")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(sessionId, "Both", undefined, [
    output,
    { kind: "text", name: "notes.txt", mimeType: "text/plain", content: "release notes" },
  ])
})

it("keeps a file that finished reading when output is offered before the next render", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread()
  const { file, finish } = slowFile()
  await user.upload(screen.getByLabelText("Choose an image or file"), file)
  const output = terminalOutputAttachment("$ pnpm test\n PASS  webhooks")

  await act(async () => {
    finish("release notes")
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
    expect(composerInbox.offer(sessionId, output)).toBe("attached")
  })

  await user.type(screen.getByRole("textbox", { name: "Message" }), "Both")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(sessionId, "Both", undefined, [
    { kind: "text", name: "notes.txt", mimeType: "text/plain", content: "release notes" },
    output,
  ])
})
