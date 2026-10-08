import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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

// The draft holds two attachments at most. A write that fills it before the
// next render still counts against the limit for the writes after it.
it("leaves a long editor paste inline when output filled the draft before the next render", async () => {
  const user = userEvent.setup()
  renderThread()
  act(() => { expect(composerInbox.offer(sessionId, terminalOutputAttachment("first"))).toBe("attached") })
  await user.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}")
  const editor = screen.getByRole("textbox", { name: "Prompt editor message" })
  const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")

  act(() => {
    expect(composerInbox.offer(sessionId, terminalOutputAttachment("second"))).toBe("attached")
    fireEvent.paste(editor, { clipboardData: { getData: () => longText } })
  })

  expect(screen.getByText(/Attach up to 2 items per message\. The pasted text stayed in the message\./u)).toBeTruthy()
  expect(screen.queryByText(/goes with the message as a file/u)).toBeNull()
})

it("says the draft is full when output filled it while a chosen file was read", async () => {
  const user = userEvent.setup()
  renderThread()
  act(() => { expect(composerInbox.offer(sessionId, terminalOutputAttachment("first"))).toBe("attached") })
  const { file, finish } = slowFile()
  await user.upload(screen.getByLabelText("Choose an image or file"), file)

  act(() => { expect(composerInbox.offer(sessionId, terminalOutputAttachment("second"))).toBe("attached") })
  await act(async () => { finish("release notes") })

  expect(screen.getByRole("alert").textContent).toBe("Attach up to 2 items per message.")
  expect(screen.getByRole("region", { name: "Attachments" }).textContent).not.toContain("notes.txt")
})

it("leaves a long composer paste inline when output filled the draft before the next render", async () => {
  renderThread()
  act(() => { expect(composerInbox.offer(sessionId, terminalOutputAttachment("first"))).toBe("attached") })
  const field = screen.getByRole("textbox", { name: "Message" })
  const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")

  let pasteProceeds = false
  act(() => {
    expect(composerInbox.offer(sessionId, terminalOutputAttachment("second"))).toBe("attached")
    pasteProceeds = fireEvent.paste(field, { clipboardData: { getData: () => longText } })
  })

  // Not prevented, so the browser puts the text in the field.
  expect(pasteProceeds).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe("Attach up to 2 items per message. The pasted text stayed in the message.")
  expect(screen.getByRole("region", { name: "Attachments" }).textContent).not.toContain("pasted-text")
})

// Output offered in the same batch as Send goes with that message, rather
// than being sent without and then cleared.
it("sends output offered in the same batch as Send", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread()
  await user.type(screen.getByRole("textbox", { name: "Message" }), "Why did this pass?")
  const output = terminalOutputAttachment("$ pnpm test\n PASS  webhooks")

  await act(async () => {
    expect(composerInbox.offer(sessionId, output)).toBe("attached")
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  })

  expect(onSend).toHaveBeenCalledWith(sessionId, "Why did this pass?", undefined, [output])
})

it("queues output offered in the same batch as Send while a turn runs", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.sessions.find((session) => session.id === sessionId)!.activeTurnId = "turn-running"
  const onQueuedChange = vi.fn()
  renderThread({ snapshot, onQueuedChange })
  await user.type(screen.getByRole("textbox", { name: "Message" }), "Also check retries")
  const output = terminalOutputAttachment("$ pnpm test\n PASS  webhooks")

  await act(async () => {
    expect(composerInbox.offer(sessionId, output)).toBe("attached")
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  })

  expect(onQueuedChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Also check retries", attachments: [output] }))
})

// A composer paste is judged against the draft as it is at that moment, for
// room and for its name.
it("takes a long composer paste as a file when a same-batch removal made room", () => {
  renderThread()
  act(() => {
    composerInbox.offer(sessionId, terminalOutputAttachment("first"))
    composerInbox.offer(sessionId, terminalOutputAttachment("second"))
  })
  const field = screen.getByRole("textbox", { name: "Message" })
  const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")

  let pasteProceeds = true
  act(() => {
    fireEvent.click(screen.getAllByRole("button", { name: /Remove terminal-output\.txt/u })[0]!)
    pasteProceeds = fireEvent.paste(field, { clipboardData: { getData: () => longText } })
  })

  expect(pasteProceeds).toBe(false)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.getByText("pasted-text-1.txt")).toBeTruthy()
})

it("names two same-batch composer pastes apart", () => {
  renderThread()
  const field = screen.getByRole("textbox", { name: "Message" })
  const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")

  act(() => {
    fireEvent.paste(field, { clipboardData: { getData: () => longText } })
    fireEvent.paste(field, { clipboardData: { getData: () => `${longText}\nmore` } })
  })

  expect(screen.getByText("pasted-text-1.txt")).toBeTruthy()
  expect(screen.getByText("pasted-text-2.txt")).toBeTruthy()
})
