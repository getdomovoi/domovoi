import type { Runtime } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi, type MockInstance } from "vitest"

import { ModeChip } from "./mode-chip"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const runtime: Runtime = { provider: "claude", model: "claude-sonnet-4.6", reasoning: "medium", permissionMode: "build", auto: false }

// The mode menu is not modal, so a click outside it reaches whatever is
// under the pointer. A pointer close there leaves focus where the person
// clicked: pulling it back to the chip would take it out of the composer
// they just clicked into (walk F6 follow-up, lead ruling on review finding 3).
function Composer() {
  return (
    <>
      <p data-testid="thread">Thread</p>
      <textarea aria-label="Message" />
      <ModeChip runtime={runtime} pending={false} onSetRuntime={() => {}} />
    </>
  )
}

function triggerFocusCalls(trigger: HTMLElement, focus: MockInstance<HTMLElement["focus"]>) {
  return focus.mock.contexts.filter((context: unknown) => context === trigger)
}

it("keeps focus in the composer when a click there closes the mode menu", async () => {
  const user = userEvent.setup()
  render(<Composer />)
  const trigger = screen.getByRole("button", { name: /^Mode: Build/u })
  await user.click(trigger)
  expect(screen.getByRole("listbox", { name: "Permission modes" })).toBeTruthy()
  const focus = vi.spyOn(HTMLElement.prototype, "focus")
  const message = screen.getByRole("textbox", { name: "Message" })
  await user.click(message)
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Permission modes" })).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(document.activeElement).toBe(message)
  expect(triggerFocusCalls(trigger, focus)).toHaveLength(0)
})

it("does not pull focus to the chip when a click on plain text closes the mode menu", async () => {
  const user = userEvent.setup()
  render(<Composer />)
  const trigger = screen.getByRole("button", { name: /^Mode: Build/u })
  await user.click(trigger)
  const focus = vi.spyOn(HTMLElement.prototype, "focus")
  await user.click(screen.getByTestId("thread"))
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Permission modes" })).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(triggerFocusCalls(trigger, focus)).toHaveLength(0)
})
