import { describe, expect, it } from "vitest"

import { shouldCollapseDockForWidth } from "./dock-auto-collapse"

// A ResizeObserver reports once as soon as it observes, and during the first
// layout pass the shell has no width yet. Treating that as a narrow window
// collapses a dock the reader pinned, so an unmeasured shell decides nothing.
describe("dock auto collapse", () => {
  it("leaves the dock alone until the shell has been measured", () => {
    expect(shouldCollapseDockForWidth(0)).toBe(false)
  })

  it("collapses a shell that is really too narrow to hold both", () => {
    expect(shouldCollapseDockForWidth(1_079)).toBe(true)
    expect(shouldCollapseDockForWidth(1_080)).toBe(false)
  })
})
