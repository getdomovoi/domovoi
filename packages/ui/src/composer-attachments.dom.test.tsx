import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function renderThread(onSend = vi.fn(async () => {})) {
  const props: ComponentProps<typeof Thread> = {
    snapshot: structuredClone(demoWorkspace),
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

it("attaches a worktree file and sends it with the prompt", async () => {
  const user = userEvent.setup()
  const onSend = renderThread()
  await user.click(screen.getByRole("button", { name: "Attach" }))
  await user.click(screen.getByRole("menuitem", { name: "File in this repo" }))
  await user.type(screen.getByRole("textbox", { name: "File in this repo" }), "src/index.ts")
  await user.click(screen.getByText("Attach"))
  expect(screen.getByRole("region", { name: "Attachments" }).textContent).toContain("src/index.ts")
  await user.type(screen.getByRole("textbox", { name: "Message" }), "Review this file")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(
    demoWorkspace.activeSessionId,
    "Review this file",
    undefined,
    [{ kind: "workspace-file", path: "src/index.ts" }],
  )
})

it("offers every signed attachment source", async () => {
  const user = userEvent.setup()
  renderThread()
  await user.click(screen.getByRole("button", { name: "Attach" }))
  const menu = screen.getByRole("menu")
  const repo = within(menu).getByRole("menuitem", { name: /File in this repo/u })
  const machine = within(menu).getByRole("menuitem", { name: new RegExp(`Path on ${demoWorkspace.machine.name}`, "u") })
  const device = within(menu).getByRole("menuitem", { name: /Image or file from this device/u })
  const terminal = within(menu).getByRole("menuitem", { name: /Paste terminal output/u })
  expect(within(repo).getByText("TS")).toBeTruthy()
  expect(repo.textContent).toContain("Nothing is copied")
  expect(within(machine).getByText("DIR")).toBeTruthy()
  expect(machine.textContent).toContain("Reading outside the project asks first")
  expect(within(device).getByText("FILE")).toBeTruthy()
  expect(device.textContent).toContain(`copied to ${demoWorkspace.machine.name}`)
  expect(within(terminal).getByText("LOG")).toBeTruthy()
  expect(terminal.textContent).toContain("kept as a file in the session")
})

it("renders attachments as removable compact chips", async () => {
  const user = userEvent.setup()
  renderThread()
  await user.click(screen.getByRole("button", { name: "Attach" }))
  await user.click(screen.getByRole("menuitem", { name: "File in this repo" }))
  await user.type(screen.getByRole("textbox", { name: "File in this repo" }), "src/thread.tsx")
  await user.click(screen.getByText("Attach"))
  const region = screen.getByRole("region", { name: "Attachments" })
  expect(region.textContent).toContain("src/thread.tsx")
  await user.click(screen.getByRole("button", { name: "Remove src/thread.tsx" }))
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull()
})

// Reading a chosen file takes time. Two reads that finish close together each
// add their file; the second must not replace the first with a draft read
// before either finished.
it("keeps both files when two reads finish close together", async () => {
  const user = userEvent.setup()
  const onSend = renderThread()
  const finishes: Array<(text: string) => void> = []
  const slowFile = (name: string) => {
    const file = new File(["x"], name, { type: "text/plain" })
    Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { finishes.push(resolve) }) })
    return file
  }
  const input = screen.getByLabelText("Choose an image or file")
  await user.upload(input, slowFile("first.txt"))
  await user.upload(input, slowFile("second.txt"))

  await act(async () => {
    finishes[0]?.("one")
    finishes[1]?.("two")
  })

  await user.type(screen.getByRole("textbox", { name: "Message" }), "Both files")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  expect(onSend).toHaveBeenCalledWith(demoWorkspace.activeSessionId, "Both files", undefined, [
    { kind: "text", name: "first.txt", mimeType: "text/plain", content: "one" },
    { kind: "text", name: "second.txt", mimeType: "text/plain", content: "two" },
  ])
})
