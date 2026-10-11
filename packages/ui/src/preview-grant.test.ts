import { describe, expect, it } from "vitest"

import { previewGrantFresh, previewGrantLabel, previewGrantRenewDelay, previewGrantRenewLeadMs, previewGrantRetryDelay } from "./preview-grant"

describe("preview grant timing", () => {
  it("names the time left on the grant, as drawn in the toolbar", () => {
    expect(previewGrantLabel(540_000)).toBe("authorized · 9m left")
    expect(previewGrantLabel(60_000)).toBe("authorized · 1m left")
    expect(previewGrantLabel(42_000)).toBe("authorized · 42s left")
    expect(previewGrantLabel(400)).toBe("authorized · 1s left")
    expect(previewGrantLabel(0)).toBe("authorization expired")
    expect(previewGrantLabel(-5_000)).toBe("authorization expired")
  })

  it("renews ahead of expiry so a frame never loads a grant about to lapse", () => {
    const now = 1_000_000
    // expiresAt is in seconds, as the daemon signs it.
    expect(previewGrantRenewDelay(now / 1_000 + 60, now)).toBe(60_000 - previewGrantRenewLeadMs)
    expect(previewGrantRenewDelay(now / 1_000 + 1, now)).toBe(0)
    expect(previewGrantFresh({ expiresAt: now / 1_000 + 60 }, now)).toBe(true)
    expect(previewGrantFresh({ expiresAt: now / 1_000 + 2 }, now)).toBe(false)
  })

  it("backs off a failing renewal to one try every 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(previewGrantRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })
})
