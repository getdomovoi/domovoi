import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu"

afterEach(cleanup)

// Walk finding F6: after the usage chip's menu was opened with the mouse and
// closed by a click elsewhere, the chip kept a focus ring nobody asked for.
// The menu handed focus back to its trigger as if the keyboard had closed it.
// A pointer close leaves focus where the pointer went; a keyboard close still
// returns focus to the trigger, so a keyboard user does not lose their place.
function Menu() {
  return (
    <>
      <p data-testid="elsewhere">Thread</p>
      <DropdownMenu>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Row</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

describe("closing a dropdown menu", () => {
  it("leaves the trigger unfocused after a mouse open and a click elsewhere", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    expect(screen.getByRole("menu")).toBeTruthy()
    await user.click(screen.getByTestId("elsewhere"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).not.toBe(trigger)
  })

  it("returns focus to the trigger when Escape closes a menu the mouse opened", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.click(trigger)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("returns focus to the trigger when the keyboard opens and closes it", async () => {
    const user = userEvent.setup()
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Usage" })
    await user.tab()
    expect(document.activeElement).toBe(trigger)
    await user.keyboard("{Enter}")
    expect(screen.getByRole("menu")).toBeTruthy()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
