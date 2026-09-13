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

// Setting a machine up is not a command. It sits where you look when no command
// in the list can help yet.
it("offers first-run setup, and hides it while a machine is being chosen", async () => {
  const user = userEvent.setup()
  const onOpenFirstRun = vi.fn()
  function Harness() {
    const [open, setOpen] = useState(true)
    return (
      <CommandPalette
        open={open}
        platform="darwin"
        onOpenFirstRun={onOpenFirstRun}
        commands={[{
          id: "session-1",
          label: "Migrate billing",
          section: "Sessions",
          keywords: [],
          kind: "SESSION",
          run: vi.fn(),
          elsewhereTargets: [
            { id: "move-1-to-b", label: "thinkpad", section: "Machines", keywords: [], kind: "MACHINE", run: vi.fn() },
          ],
        }]}
        onOpenChange={setOpen}
        restoreFocusTo={null}
      />
    )
  }
  render(<Harness />)

  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(screen.queryByRole("button", { name: "First-run setup" })).toBeNull()

  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("button", { name: "First-run setup" }))
  expect(onOpenFirstRun).toHaveBeenCalledOnce()
})

// The picker is a step inside one open of the launcher, not a mode the launcher
// keeps. Every way out (a chosen target, a plain action, the parent closing)
// leaves the next open at the root, and the session being moved is looked up by
// id in the current commands rather than kept as an object, so a target the
// list no longer offers cannot run and a list that changed underneath is what
// Enter acts on.
const target = (id: string, run = vi.fn()): WorkspaceCommand => ({ id, label: id, section: "Machines", keywords: [], run })
const session = (targets: WorkspaceCommand[]): WorkspaceCommand => ({
  id: "session-a", label: "Session A", section: "Sessions", keywords: [], elsewhereTargets: targets, run: vi.fn(),
})
const view = (commands: WorkspaceCommand[], open = true, onOpenChange = vi.fn()) => (
  <CommandPalette commands={commands} open={open} onOpenChange={onOpenChange} platform="darwin" restoreFocusTo={null} />
)

it("reopens at the root after a target is chosen", async () => {
  const user = userEvent.setup()
  const run = vi.fn()
  const commands = [session([target("remote-a", run)])]
  const changed = vi.fn()
  const { rerender } = render(view(commands, true, changed))
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  await user.keyboard("{Enter}")
  expect(run).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledWith(false)
  rerender(view(commands, false, changed))
  rerender(view(commands, true, changed))
  expect(hints()).not.toContain("move Session A")
  expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(["Session A"])
})

it("acts on the current targets, not the ones it was opened with", async () => {
  const user = userEvent.setup()
  const removed = vi.fn()
  const current = vi.fn()
  const { rerender } = render(view([session([target("removed-target", removed)])]))
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  rerender(view([session([target("current-target", current)])]))
  await user.keyboard("{Enter}")
  expect(removed).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledOnce()
})

it("filters the machines with the search input", async () => {
  const user = userEvent.setup()
  render(view([session([target("mac-mini"), target("thinkpad")])]))
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  await user.type(screen.getByRole("combobox"), "thinkpad")
  expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(["thinkpad"])
})

it("does not offer to move a session that has nowhere to go", () => {
  render(view([session([])]))
  expect(hints()).not.toContain("open elsewhere")
})
