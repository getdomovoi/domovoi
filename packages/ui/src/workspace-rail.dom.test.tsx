import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { WorkspaceSurface } from "./workspace-persistence.js"
import { WorkspaceRail } from "./workspace-rail.js"

afterEach(cleanup)

function railProps() {
  return {
    surface: "workspace" as WorkspaceSurface,
    dockTab: "changes",
    machineName: "macbook-pro-m3",
    onSelectSurface: vi.fn(),
    onSelectDockTab: vi.fn(),
  }
}

function renderRail(overrides: Partial<ReturnType<typeof railProps>> = {}) {
  const props = { ...railProps(), ...overrides }
  render(<TooltipProvider><WorkspaceRail {...props} /></TooltipProvider>)
  return props
}

it("opens the workspace panes the design system puts on the rail", async () => {
  const props = renderRail()

  for (const [name, tab] of [["Changes", "changes"], ["Terminal", "terminal"], ["Preview", "preview"]] as const) {
    await userEvent.click(screen.getByRole("button", { name }))
    expect(props.onSelectDockTab).toHaveBeenCalledWith(tab)
  }
  expect(props.onSelectSurface).toHaveBeenCalledWith("workspace")
})

it("returns to the sessions workspace without touching the open pane", async () => {
  const props = renderRail({ surface: "skills" })

  await userEvent.click(screen.getByRole("button", { name: "Sessions" }))

  expect(props.onSelectSurface).toHaveBeenCalledWith("workspace")
  expect(props.onSelectDockTab).not.toHaveBeenCalled()
})

it("opens settings from the rail", async () => {
  const props = renderRail()

  await userEvent.click(screen.getByRole("button", { name: "Settings" }))

  expect(props.onSelectSurface).toHaveBeenCalledWith("providers")
})

it("marks the open pane, and marks none while another section is open", () => {
  renderRail({ dockTab: "terminal" })
  expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-current")).toBe("page")

  cleanup()
  renderRail({ surface: "skills", dockTab: "terminal" })
  expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-current")).toBeNull()
})

it("names the machine behind the account avatar", () => {
  renderRail()

  expect(screen.getByLabelText("Signed in on macbook-pro-m3")).toBeTruthy()
})
