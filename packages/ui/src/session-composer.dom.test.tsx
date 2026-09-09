import type { Runtime } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { SessionComposer } from "./session-composer"

afterEach(cleanup)

const runtime: Runtime = {
  provider: "claude-code",
  model: "claude-sonnet-4-6",
  reasoning: "high",
  permissionMode: "build",
  auto: true,
}

const commands = [
  { name: "/run", argument: "<command>", describe: "Run a command through the gate" },
  { name: "/plan", describe: "Ask for a plan before any write" },
]

function composer(overrides: Partial<Parameters<typeof SessionComposer>[0]> = {}) {
  const props = {
    runtime,
    turnRunning: false,
    modelLabel: "claude-sonnet-4.6",
    slashCommands: commands,
    onSend: vi.fn(),
    onQueue: vi.fn(),
    onRemoveQueued: vi.fn(),
    onSetRuntime: vi.fn(),
    onOpenModelPicker: vi.fn(),
    ...overrides,
  }
  render(<SessionComposer {...props} />)
  return props
}

it("sends when no turn is running", async () => {
  const user = userEvent.setup()
  const props = composer()
  await user.type(screen.getByLabelText("Message"), "add a test")
  await user.click(screen.getByRole("button", { name: "Send" }))
  expect(props.onSend).toHaveBeenCalledWith("add a test")
  expect(props.onQueue).not.toHaveBeenCalled()
})

it("queues while a turn is running, and never sends", async () => {
  const user = userEvent.setup()
  const props = composer({ turnRunning: true })
  await user.type(screen.getByLabelText("Message"), "also the readme")
  await user.click(screen.getByRole("button", { name: "Queue" }))
  expect(props.onQueue).toHaveBeenCalledWith("also the readme")
  expect(props.onSend).not.toHaveBeenCalled()
  expect(screen.getByText("sends at the next turn boundary")).toBeTruthy()
})

it("clears auto when the mode leaves build", async () => {
  const user = userEvent.setup()
  const props = composer()
  await user.click(screen.getByRole("button", { name: /Build · auto/ }))
  await user.click(screen.getByRole("button", { name: /Ask/ }))
  expect(props.onSetRuntime).toHaveBeenCalledWith({ ...runtime, permissionMode: "ask", auto: false })
})

it("offers the auto control only in build", async () => {
  const user = userEvent.setup()
  composer({ runtime: { ...runtime, permissionMode: "ask", auto: false } })
  await user.click(screen.getByRole("button", { name: /Ask/ }))
  expect(screen.queryByText(/Auto, no gate/)).toBeNull()
  cleanup()
  composer()
  await user.click(screen.getByRole("button", { name: /Build · auto/ }))
  expect(screen.getByText(/Auto, no gate/)).toBeTruthy()
})

it("opens the command list on a slash, and says it acts on this turn", async () => {
  const user = userEvent.setup()
  composer()
  await user.type(screen.getByLabelText("Message"), "/")
  expect(screen.getByText("THIS TURN")).toBeTruthy()
  expect(screen.getByRole("option", { name: /\/run/ })).toBeTruthy()
})

// Removing a queued turn has to travel. Clearing the banner alone leaves the
// turn queued wherever the parent put it, with nothing on screen saying so.
it("reports a removed queued turn instead of only clearing its banner", async () => {
  const user = userEvent.setup()
  const props = composer({ turnRunning: true })
  await user.type(screen.getByLabelText("Message"), "also the readme")
  await user.keyboard("{Enter}")
  expect(props.onQueue).toHaveBeenCalledWith("also the readme")

  await user.click(screen.getByRole("button", { name: "Remove" }))
  expect(props.onRemoveQueued).toHaveBeenCalledOnce()
  expect(screen.queryByText("sends at the next turn boundary")).toBeNull()
})

// The list is reachable by pointer already. A command list you can only click
// is half a control, and the composer is where hands stay on the keyboard.
it("walks the command list with the arrow keys", async () => {
  const user = userEvent.setup()
  composer()
  const message = screen.getByLabelText("Message")
  await user.type(message, "/")
  expect(message.getAttribute("aria-expanded")).toBe("true")
  expect(message.getAttribute("aria-activedescendant")).toBeNull()

  await user.keyboard("{ArrowDown}")
  const run = screen.getByRole("option", { name: /\/run/ })
  expect(run.getAttribute("aria-selected")).toBe("true")
  expect(message.getAttribute("aria-activedescendant")).toBe(run.id)

  await user.keyboard("{ArrowDown}")
  expect(screen.getByRole("option", { name: /\/plan/ }).getAttribute("aria-selected")).toBe("true")
  expect(run.getAttribute("aria-selected")).toBe("false")
})

it("takes the highlighted command on Enter instead of sending the text", async () => {
  const user = userEvent.setup()
  const props = composer()
  const message = screen.getByLabelText("Message")
  await user.type(message, "/")
  await user.keyboard("{ArrowDown}{Enter}")

  expect(props.onSend).not.toHaveBeenCalled()
  expect((message as HTMLTextAreaElement).value).toBe("/run ")
  expect(screen.queryByRole("listbox")).toBeNull()
})

it("closes the command list on Escape without sending", async () => {
  const user = userEvent.setup()
  const props = composer()
  const message = screen.getByLabelText("Message")
  await user.type(message, "/")
  await user.keyboard("{Escape}")

  expect(screen.queryByRole("listbox")).toBeNull()
  expect(props.onSend).not.toHaveBeenCalled()
  expect((message as HTMLTextAreaElement).value).toBe("/")
})

it("still sends a plain message with the list closed", async () => {
  const user = userEvent.setup()
  const props = composer()
  await user.type(screen.getByLabelText("Message"), "ship it")
  await user.keyboard("{Enter}")
  expect(props.onSend).toHaveBeenCalledWith("ship it")
})

// Pointer selection has to leave the caret where the keyboard would. Clicking
// an option focuses its button, and dismissing the list then unmounts that
// button, so without a deliberate return focus lands on the body.
it("returns focus to the message after a command is clicked", async () => {
  const user = userEvent.setup()
  composer()
  const message = screen.getByLabelText("Message")
  await user.type(message, "/")
  await user.click(screen.getByRole("option", { name: /\/run/ }))

  expect(screen.queryByRole("listbox")).toBeNull()
  expect(document.activeElement).toBe(message)
  await user.keyboard("build")
  expect((message as HTMLTextAreaElement).value).toBe("/run build")
})

// Accepting a command that is already the whole text does not change the value,
// so nothing moves the caret on its own. Home first, then a pick, is the case
// that catches it.
it("puts the caret after the command even when the text does not change", async () => {
  const user = userEvent.setup()
  composer()
  const message = screen.getByLabelText("Message") as HTMLTextAreaElement
  await user.type(message, "/run ")
  await user.keyboard("{Home}")
  await user.click(screen.getByRole("option", { name: /\/run/ }))
  await user.keyboard("argument")

  expect(message.value).toBe("/run argument")
})
