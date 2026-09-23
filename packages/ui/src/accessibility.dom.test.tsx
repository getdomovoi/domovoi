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
      onNewSession={vi.fn()}
      onOpenMachines={vi.fn()}
      onOpenSettings={vi.fn()}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onOpenCommands={vi.fn()}
      onToggleTheme={vi.fn()}
      commandShortcut="Ctrl+K"
      sessionsDrawer={<button type="button" aria-label="Sessions" className="electron-no-drag focus-visible:ring-2">Sessions</button>}
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
      "Sessions",
      "New session",
      "Open command palette",
      `Machines: ${demoWorkspace.machine.name}`,
      "Stop everything",
      "Settings",
      "Use light theme",
    ])

    for (const button of focusable) {
      await user.tab()
      expect(document.activeElement).toBe(button)
      expect(button.className).toContain("focus-visible:ring-")
      expect(button.closest(".electron-no-drag")).not.toBeNull()
    }

    await user.tab()
    expect(document.activeElement).toBe(document.body)
  })

  it("draws the signed titlebar tooltips", async () => {
    const user = userEvent.setup()
    renderTopBar()

    await user.hover(screen.getByRole("button", { name: "New session" }))
    expect(await screen.findByText("New session · Ctrl+N")).toBeTruthy()

    cleanup()
    renderTopBar()
    await user.hover(screen.getByRole("button", { name: "Use light theme" }))
    expect(await screen.findByText("Light appearance")).toBeTruthy()
  })
})
