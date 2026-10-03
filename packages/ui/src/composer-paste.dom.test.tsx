import { demoWorkspace } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function renderThread(onSend = vi.fn(async () => {})) {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
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
  }
  render(<Thread {...props} />)
  return onSend
}

const field = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement

// 640 lines of 28 characters: 17,920 characters and 639 newlines.
const log = Array.from({ length: 640 }, (_, index) => `worker line ${String(index + 1).padStart(4, "0")} ok`.padEnd(28, ".")).join("\n")

// The design: a paste past the inline limit becomes pasted-text-N.txt, drawn
// as an info card with its size and line count, Peek, a drop control and the
// note. The prompt carries the first 40 lines, so that is the limit.
it("turns a paste over 40 lines into a text file the message carries", async () => {
  const user = userEvent.setup()
  const onSend = renderThread()
  await user.click(field())
  await user.paste(log)

  expect(field().value).toBe("")
  const card = screen.getByRole("group", { name: "pasted-text-1.txt" })
  expect(within(card).getByText("TXT")).toBeTruthy()
  expect(within(card).getByText("18.6 kB · 640 lines")).toBeTruthy()
  expect(card.textContent).toContain("Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest on request.")
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull()

  await user.click(within(card).getByRole("button", { name: "Peek" }))
  const peek = within(card).getByRole("region", { name: "First 40 lines of pasted-text-1.txt" })
  expect(peek.textContent).toContain("worker line 0001 ok")
  expect(peek.textContent).toContain("worker line 0040 ok")
  expect(peek.textContent).not.toContain("worker line 0041 ok")
  expect(peek.textContent).toContain("… 600 more lines")
  await user.click(within(card).getByRole("button", { name: "Hide" }))
  expect(within(card).queryByRole("region")).toBeNull()

  await user.type(field(), "Why does the queue drain slowly?")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(
    demoWorkspace.activeSessionId,
    "Why does the queue drain slowly?",
    undefined,
    [{ kind: "text", name: "pasted-text-1.txt", mimeType: "text/plain", content: log }],
  )
})

it("keeps a paste of 40 lines or fewer in the message", async () => {
  const user = userEvent.setup()
  renderThread()
  const short = log.split("\n").slice(0, 40).join("\n")
  await user.click(field())
  await user.paste(short)

  expect(field().value).toBe(short)
  expect(screen.queryByRole("group", { name: /pasted-text/u })).toBeNull()
})

it("leaves a paste past the attachment limit in the message and says why", async () => {
  const user = userEvent.setup()
  renderThread()
  const huge = Array.from({ length: 41 }, () => "x".repeat(7_000)).join("\n")
  await user.click(field())
  await user.paste(huge)

  expect(field().value).toBe(huge)
  expect(screen.queryByRole("group", { name: /pasted-text/u })).toBeNull()
  expect(screen.getByRole("alert").textContent).toBe("Pasted text exceeds the 256 KB attachment limit, so it stayed in the message.")
})

it("numbers each pasted file and drops one without touching the other", async () => {
  const user = userEvent.setup()
  renderThread()
  await user.click(field())
  await user.paste(log)
  await user.paste(`${log}\nmore`)

  expect(screen.getByRole("group", { name: "pasted-text-1.txt" })).toBeTruthy()
  const second = screen.getByRole("group", { name: "pasted-text-2.txt" })
  expect(within(second).getByText(/· 641 lines$/u)).toBeTruthy()

  await user.click(within(screen.getByRole("group", { name: "pasted-text-1.txt" })).getByRole("button", { name: "Remove pasted-text-1.txt" }))
  expect(screen.queryByRole("group", { name: "pasted-text-1.txt" })).toBeNull()
  expect(screen.getByRole("group", { name: "pasted-text-2.txt" })).toBeTruthy()
})
