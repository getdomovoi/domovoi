import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Chip } from "./chip"
import { FloatingSurface } from "./floating-surface"
import { StatusDot } from "./status-dot"

afterEach(cleanup)

describe("StatusDot", () => {
  it("states its meaning in text, never in colour alone", () => {
    render(<StatusDot meaning="waiting" label="waiting on you" />)
    expect(screen.getByText("waiting on you")).toBeTruthy()
  })

  it("gives each meaning its own fill", () => {
    const fills = new Set<string>()
    for (const meaning of ["online", "waiting", "offline", "handoff", "idle"] as const) {
      const { container } = render(<StatusDot meaning={meaning} label={meaning} />)
      fills.add(container.querySelector("span > span")!.className)
      cleanup()
    }
    expect(fills.size).toBe(5)
  })

  it("offers the three sizes the guidelines name", () => {
    const sizes = new Set<string>()
    for (const size of ["inline", "default", "header"] as const) {
      const { container } = render(<StatusDot meaning="online" label="online" size={size} />)
      sizes.add(container.querySelector("span > span")!.className)
      cleanup()
    }
    expect(sizes.size).toBe(3)
  })
})

describe("Chip", () => {
  it("keeps its three paddings distinct", () => {
    const paddings = new Set<string>()
    for (const size of ["badge", "chip", "control"] as const) {
      const { container } = render(<Chip size={size}>ask</Chip>)
      paddings.add(container.firstElementChild!.className)
      cleanup()
    }
    expect(paddings.size).toBe(3)
  })

  it("uses mono only when the content is machine output", () => {
    const { container: prose } = render(<Chip>Ask</Chip>)
    expect(prose.firstElementChild!.className).not.toContain("font-mono")
    cleanup()
    const { container: machine } = render(<Chip mono>8f3c1de</Chip>)
    expect(machine.firstElementChild!.className).toContain("font-mono")
  })

  it("is a button only when it does something", () => {
    render(<Chip>build</Chip>)
    expect(screen.queryByRole("button")).toBeNull()
    cleanup()
    render(<Chip onClick={vi.fn()}>build</Chip>)
    expect(screen.getByRole("button", { name: "build" })).toBeTruthy()
  })
})

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <FloatingSurface open={open} onClose={() => setOpen(false)} label="Sessions">
        <button type="button">Inside</button>
      </FloatingSurface>
      <button type="button">Outside</button>
    </div>
  )
}

describe("FloatingSurface", () => {
  it("renders nothing until it is opened", () => {
    render(<Harness />)
    expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull()
  })

  it("closes on Escape and returns focus to whatever opened it", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "Open" })
    await user.click(opener)
    expect(screen.getByRole("group", { name: "Sessions" })).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it("closes on a click outside itself", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Open" }))
    await user.click(screen.getByRole("button", { name: "Outside" }))
    expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull()
  })

  it("stays open when the click lands inside it", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Open" }))
    await user.click(screen.getByRole("button", { name: "Inside" }))
    expect(screen.getByRole("group", { name: "Sessions" })).toBeTruthy()
  })
})
