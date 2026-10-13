import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { StatusDot } from "./status-dot"

afterEach(cleanup)

// The atom's rule is that colour is never the sole carrier of meaning. A row
// that draws the dot beside its own prose has no room for a second visible
// label, but hiding the label is not the same as dropping it: the outcome still
// has to reach anyone who cannot see the colour.
it("keeps the label readable to a screen reader when it is visually hidden", () => {
  render(<StatusDot meaning="offline" label="failed" labelHidden />)

  const label = screen.getByText("failed")
  expect(label.className).toContain("sr-only")
})

it("draws the label beside the dot by default", () => {
  render(<StatusDot meaning="online" label="succeeded" />)

  expect(screen.getByText("succeeded").className).not.toContain("sr-only")
})

// Desktop V2 draws a step still running in primary (Domovoi Desktop V2.dc.html,
// the running bash step's color var(--primary), drawn by this.dot(t.color, 6)).
it("draws a step in flight in the primary colour", () => {
  render(<StatusDot meaning="working" label="bash" />)

  const dot = document.querySelector("[data-status-dot]")!
  expect(dot.className.split(/\s+/u)).toContain("bg-primary")
})

it("keeps the five state colours as they were", () => {
  const fills = { online: "bg-success", waiting: "bg-warning", offline: "bg-destructive", handoff: "bg-info", idle: "bg-faint" } as const
  for (const [meaning, fill] of Object.entries(fills)) {
    cleanup()
    render(<StatusDot meaning={meaning as keyof typeof fills} label={meaning} />)
    expect(document.querySelector("[data-status-dot]")!.className.split(/\s+/u)).toContain(fill)
  }
})
