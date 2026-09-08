import { describe, expect, it } from "vitest"

import { overflowSlack, scrollerScrolls } from "./scroller-overflow"

function scrolls(content: number | undefined, viewport: number | undefined, pull = false) {
  return scrollerScrolls({ content, viewport, pullToRefresh: pull })
}

describe("scrollerScrolls", () => {
  it("does not scroll a screen whose content is shorter than the viewport", () => {
    expect(scrolls(400, 844)).toBe(false)
  })

  // The two boundary cases: content that exactly fills its viewport has nothing
  // below the fold, and content one point past it barely does.
  it("does not scroll content that exactly fills the viewport", () => {
    expect(scrolls(844, 844)).toBe(false)
  })

  it("scrolls content that is taller than the viewport", () => {
    expect(scrolls(845 + overflowSlack, 844)).toBe(true)
  })

  it("treats a fraction of a point as rounding rather than as overflow", () => {
    expect(scrolls(844.3333, 844)).toBe(false)
    expect(scrolls(844 + overflowSlack, 844)).toBe(false)
  })

  // A screen locked shut by a measurement that never arrived is worse than one
  // that bounces with nothing to show.
  it("scrolls until it has been measured", () => {
    expect(scrolls(undefined, undefined)).toBe(true)
    expect(scrolls(400, undefined)).toBe(true)
    expect(scrolls(undefined, 844)).toBe(true)
  })

  // The pull is the only way to reach a refresh, so it survives a screen that
  // fits. Without this, a short session list could never be refreshed by hand.
  it("keeps the pull available on a screen that refreshes", () => {
    expect(scrolls(400, 844, true)).toBe(true)
  })

  it("still refuses to bounce a short screen that has no pull", () => {
    expect(scrolls(400, 844, false)).toBe(false)
  })
})
