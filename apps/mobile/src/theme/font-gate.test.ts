import { describe, expect, it } from "vitest"

import { drawWithFonts, fontWaitLimitMs } from "./font-gate"

describe("drawWithFonts", () => {
  it("holds the first render while the faces are still loading", () => {
    expect(drawWithFonts({ loaded: false, failed: false, waitedOut: false })).toBe(false)
  })

  it("draws once the faces are registered", () => {
    expect(drawWithFonts({ loaded: true, failed: false, waitedOut: false })).toBe(true)
  })

  it("draws with the platform face when loading fails", () => {
    expect(drawWithFonts({ loaded: false, failed: true, waitedOut: false })).toBe(true)
  })

  it("draws with the platform face once the wait limit passes", () => {
    expect(drawWithFonts({ loaded: false, failed: false, waitedOut: true })).toBe(true)
  })

  it("bounds the wait to a few seconds", () => {
    expect(fontWaitLimitMs).toBeGreaterThan(0)
    expect(fontWaitLimitMs).toBeLessThanOrEqual(5000)
  })
})
