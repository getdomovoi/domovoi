import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { AppBar } from "./workspace-shell"

afterEach(cleanup)

function renderTopBar() {
  return render(
    <AppBar
      snapshot={demoWorkspace}
      connected
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      onOpenProject={vi.fn()}
      onPauseAll={vi.fn()}
      onOpenCommands={vi.fn()}
      commandShortcut="Ctrl+K"
    />,
  )
}

describe("top bar keyboard focus", () => {
  it("tabs through the top bar in reading order with a visible focus style", async () => {
    const user = userEvent.setup()
    renderTopBar()

    const focusable = screen
      .getAllByRole("button")
      .filter((button) => !(button as HTMLButtonElement).disabled)
    expect(focusable.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      expect.stringContaining(demoWorkspace.project?.name ?? "Open project"),
      "Open command palette",
      "Pause all",
    ])

    for (const button of focusable) {
      await user.tab()
      expect(document.activeElement).toBe(button)
      expect(button.className).toContain("focus-visible:ring-")
    }

    await user.tab()
    expect(document.activeElement).toBe(document.body)
  })
})
