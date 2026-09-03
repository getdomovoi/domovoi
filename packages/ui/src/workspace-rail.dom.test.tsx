import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkspaceRail } from "./workspace-rail.js"

afterEach(cleanup)

function railProps() {
  return {
    surface: "workspace" as const,
    machineName: "macbook-pro-m3",
    onSelectSurface: vi.fn(),
  }
}

it("switches between every section from one permanent rail", async () => {
  const props = railProps()
  render(<TooltipProvider><WorkspaceRail {...props} /></TooltipProvider>)

  for (const [name, surface] of [
    ["Sessions", "workspace"],
    ["Fleet", "fleet"],
    ["Skills", "skills"],
    ["Audit log", "audit"],
    ["Settings", "providers"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name }))
    expect(props.onSelectSurface).toHaveBeenCalledWith(surface)
  }
})

it("marks the open section for assistive technology", () => {
  render(<TooltipProvider><WorkspaceRail {...railProps()} surface="skills" /></TooltipProvider>)

  expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("page")
  expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-current")).toBeNull()
})

it("names the machine behind the account avatar", () => {
  render(<TooltipProvider><WorkspaceRail {...railProps()} /></TooltipProvider>)

  expect(screen.getByLabelText("Signed in on macbook-pro-m3")).toBeTruthy()
})
