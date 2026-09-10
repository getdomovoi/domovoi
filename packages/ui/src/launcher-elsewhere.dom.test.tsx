import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { CommandPalette, type CommandPalettePlatform, type WorkspaceCommand } from "./command-palette"

afterEach(cleanup)

function palette(commands: WorkspaceCommand[], platform: CommandPalettePlatform = "darwin") {
  function Harness() {
    const [open, setOpen] = useState(true)
    return <CommandPalette open={open} platform={platform} commands={commands} onOpenChange={setOpen} restoreFocusTo={null} />
  }
  render(<Harness />)
}

const hints = () => screen.getByTestId("palette-hints").textContent ?? ""

// The footer is the only part of this surface that changes per row. It says
// what the modified key would do here, rather than advertising it on rows where
// pressing it does nothing and says nothing about why.
it("offers the hint only while a row that can take it is highlighted", async () => {
  const user = userEvent.setup()
  const openElsewhere = vi.fn()
  palette([
    { id: "machine-a", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", openElsewhere, run: vi.fn() },
    { id: "open-project", label: "Open project", section: "Project", keywords: [], run: vi.fn() },
  ])

  expect(hints()).toContain("Enter open elsewhere")

  await user.keyboard("{ArrowDown}")
  expect(hints()).not.toContain("Enter open elsewhere")

  await user.keyboard("{ArrowUp}")
  expect(hints()).toContain("Enter open elsewhere")
})

it("acts on the highlighted row, and does nothing on a row that cannot take it", async () => {
  const user = userEvent.setup()
  const openElsewhere = vi.fn()
  const run = vi.fn()
  palette([
    { id: "machine-a", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", openElsewhere, run: vi.fn() },
    { id: "open-project", label: "Open project", section: "Project", keywords: [], run },
  ])

  await user.keyboard("{ArrowDown}")
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(openElsewhere).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()

  await user.keyboard("{ArrowUp}")
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(openElsewhere).toHaveBeenCalledOnce()
})

// cmdk reports the highlighted row by value, and the value is the command id.
// If an upgrade stops reporting it, this fails rather than the binding going
// quietly inert.
it("identifies the highlighted row by command id", async () => {
  const user = userEvent.setup()
  palette([
    { id: "machine-a", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", openElsewhere: vi.fn(), run: vi.fn() },
    { id: "machine-b", label: "hetzner", section: "Machines", keywords: [], kind: "MACHINE", openElsewhere: vi.fn(), run: vi.fn() },
  ])

  const rows = screen.getAllByRole("option")
  expect(rows.map((row) => row.getAttribute("data-value"))).toEqual(["machine-a", "machine-b"])
  expect(rows[0]?.getAttribute("data-selected")).toBe("true")

  await user.keyboard("{ArrowDown}")
  expect(screen.getAllByRole("option")[1]?.getAttribute("data-selected")).toBe("true")
})

// The launcher picks the machine. The preflight takes the decision, so nothing
// here moves anything on its own.
it("asks which machine, then hands the choice on", async () => {
  const user = userEvent.setup()
  const preview = vi.fn()
  palette([
    {
      id: "session-1",
      label: "Migrate billing",
      section: "Sessions",
      keywords: [],
      kind: "SESSION",
      run: vi.fn(),
      elsewhereTargets: [
        { id: "move-1-to-b", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", run: preview },
      ],
    },
    { id: "open-project", label: "Open project", section: "Project", keywords: [], run: vi.fn() },
  ])

  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(screen.getByRole("option", { name: /thinkpad/ })).toBeTruthy()
  expect(screen.queryByRole("option", { name: /Open project/ })).toBeNull()
  expect(hints()).toContain("Enter move Migrate billing here")
  expect(preview).not.toHaveBeenCalled()

  await user.keyboard("{Enter}")
  expect(preview).toHaveBeenCalledOnce()
})

it("steps back out of the choice before it closes the launcher", async () => {
  const user = userEvent.setup()
  palette([
    {
      id: "session-1",
      label: "Migrate billing",
      section: "Sessions",
      keywords: [],
      kind: "SESSION",
      run: vi.fn(),
      elsewhereTargets: [
        { id: "move-1-to-b", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", run: vi.fn() },
      ],
    },
  ])

  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(screen.getByRole("option", { name: /thinkpad/ })).toBeTruthy()

  await user.keyboard("{Escape}")
  expect(screen.getByRole("option", { name: /Migrate billing/ })).toBeTruthy()
  expect(hints()).toContain("Escape close")
})
