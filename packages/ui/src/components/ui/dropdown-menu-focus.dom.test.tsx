import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Walk finding F6: after the usage chip's menu was opened with the mouse and
// closed by a click elsewhere, the chip kept a focus ring nobody asked for.
// The menu handed focus back to its trigger as if the keyboard had closed it.
// A pointer close still returns focus to the trigger, so the next Tab starts
// there, but asks the browser not to draw it as keyboard focus. A keyboard
// close returns focus the way it always did.
function Menu({ onCloseAutoFocus }: { onCloseAutoFocus?: (event: Event) => void }) {
  return (
    <>
      <p data-testid="elsewhere">Thread</p>
      <button type="button">Composer</button>
      <DropdownMenu>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
          <DropdownMenuItem>Row</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

function quietFocusCalls(trigger: HTMLElement, focus: MockInstance<HTMLElement["focus"]>) {
  return focus.mock.contexts
    .map((context: unknown, index: number) => ({ context, options: focus.mock.calls[index]?.[0] as (FocusOptions & { focusVisible?: boolean }) | undefined }))
    .filter(({ context, options }) => context === trigger && options?.focusVisible === false)
}

describe("closing a dropdown menu", () => {
  it("returns focus to the trigger without a keyboard ring after a mouse open and a click elsewhere", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    expect(screen.getByRole("menu")).toBeTruthy()
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    await user.click(screen.getByTestId("elsewhere"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(quietFocusCalls(trigger, focus)).toHaveLength(1)
  })

  it("keeps the trigger as the place the next Tab starts from after a mouse selection", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    await user.click(screen.getByRole("menuitem", { name: "Row" }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(quietFocusCalls(trigger, focus)).toHaveLength(1)
  })

  it("returns focus to the trigger the usual way when Escape closes a menu the mouse opened", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(quietFocusCalls(trigger, focus)).toHaveLength(0)
  })

  it("returns focus to the trigger when the keyboard opens and closes it", async () => {
    const user = userEvent.setup()
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(trigger)
    await user.keyboard("{Enter}")
    expect(screen.getByRole("menu")).toBeTruthy()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("leaves focus where a caller's own close handler put it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu onCloseAutoFocus={(event) => {
      event.preventDefault()
      screen.getByRole("button", { name: "Composer" }).focus()
    }} />)
    await user.click(screen.getByRole("button", { name: "Usage" }))
    await user.click(screen.getByTestId("elsewhere"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Composer" })))
  })

  // Radix leaves focus alone after a secondary click outside, so the
  // browser's context menu keeps its target. A pointer close is a primary one.
  it("leaves focus alone after a right click elsewhere", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("elsewhere") })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).not.toBe(trigger)
    expect(quietFocusCalls(trigger, focus)).toHaveLength(0)
  })
})
