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
  expect(screen.queryByLabelText(/Auto, no gate/)).toBeNull()
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
