import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"

import { MachineSheet, type SheetTab } from "./machine-sheet"

afterEach(cleanup)

const tabs: SheetTab[] = [
  { id: "plan", label: "Plan preview", count: "4 steps", describe: "The working plan as a document" },
  { id: "changes", label: "Changes", count: "7", describe: "Diffs from the worktree on the machine" },
  { id: "terminal", label: "Terminal", describe: "The raw stream from the machine, read-only" },
]

function Harness({ startPinned = false }: { startPinned?: boolean }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(startPinned)
  const [tab, setTab] = useState("changes")
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open changes</button>
      <MachineSheet
        open={open}
        pinned={pinned}
        tabs={tabs}
        activeTab={tab}
        onSelectTab={setTab}
        onClose={() => setOpen(false)}
        onTogglePin={() => setPinned((current) => !current)}
      >
        <p>{tab} pane</p>
      </MachineSheet>
    </div>
  )
}

it("stays out of the way until something opens it", () => {
  render(<Harness />)
  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()
})

it("dims the thread while it is borrowed space, and closes on the scrim", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  const scrim = screen.getByRole("button", { name: "Close the sheet" })
  await user.click(scrim)
  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()
})

it("closes on Escape and returns focus while floating", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  const opener = screen.getByRole("button", { name: "Open changes" })
  await user.click(opener)
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it("stops dimming and stops answering Escape once pinned", async () => {
  const user = userEvent.setup()
  render(<Harness startPinned />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  expect(screen.queryByRole("button", { name: "Close the sheet" })).toBeNull()
  await user.keyboard("{Escape}")
  expect(screen.getByRole("region", { name: "Machine surfaces" })).toBeTruthy()
})

it("names every surface and marks the one in view", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  expect(screen.getByRole("tab", { name: /Changes/ }).getAttribute("aria-selected")).toBe("true")
  await user.click(screen.getByRole("tab", { name: /Terminal/ }))
  expect(screen.getByText("terminal pane")).toBeTruthy()
  expect(screen.getByRole("tab", { name: /Changes/ }).getAttribute("aria-selected")).toBe("false")
})

it("says which surfaces carry a count and which do not", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  expect(screen.getByRole("tab", { name: "Changes 7" })).toBeTruthy()
  expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy()
})

it("reports its own pinned state", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  const pin = screen.getByRole("button", { name: "Pin" })
  expect(pin.getAttribute("aria-pressed")).toBe("false")
  await user.click(pin)
  expect(screen.getByRole("button", { name: "Unpin" }).getAttribute("aria-pressed")).toBe("true")
})

// Pinning is not closing. The focus return belongs to the close, so keying it
// on pinned as well pulled focus out of an open sheet the moment it was pinned.
it("keeps focus in the sheet when it is pinned open", async () => {
  const user = userEvent.setup()
  render(<Harness />)
  const opener = screen.getByRole("button", { name: "Open changes" })
  await user.click(opener)
  const pin = screen.getByRole("button", { name: "Pin" })
  await user.click(pin)
  expect(screen.getByRole("region", { name: "Machine surfaces" })).toBeTruthy()
  expect(document.activeElement).not.toBe(opener)
})

it("returns focus when a pinned sheet closes", async () => {
  const user = userEvent.setup()
  render(<Harness startPinned />)
  const opener = screen.getByRole("button", { name: "Open changes" })
  await user.click(opener)
  await user.click(screen.getByRole("button", { name: "Unpin" }))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("region", { name: "Machine surfaces" })).toBeNull()
  expect(document.activeElement).toBe(opener)
})

// A pinned sheet sits in the layout. Carrying absolute and relative together
// left its position to CSS rule order rather than to intent.
it("takes one position, not two, when pinned", async () => {
  const user = userEvent.setup()
  render(<Harness startPinned />)
  await user.click(screen.getByRole("button", { name: "Open changes" }))
  const frame = screen.getByRole("region", { name: "Machine surfaces" }).parentElement!
  expect(frame.className).toContain("relative")
  expect(frame.className).not.toContain("absolute")
})
