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
