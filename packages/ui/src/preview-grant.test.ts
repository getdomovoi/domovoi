import { describe, expect, it } from "vitest"

import {
  previewGrantFresh,
  previewGrantLabel,
  previewGrantLocalExpiry,
  previewGrantMinimumLifetimeMs,
  previewGrantRenewDelay,
  previewGrantRenewLeadMs,
  previewGrantRetryDelay,
} from "./preview-grant"

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
    expect(previewGrantRenewDelay(now + 60_000, now)).toBe(60_000 - previewGrantRenewLeadMs)
    expect(previewGrantRenewDelay(now + 1_000, now)).toBe(0)
    expect(previewGrantFresh(now + 60_000, now)).toBe(true)
    expect(previewGrantFresh(now + 2_000, now)).toBe(false)
  })

  it("reads the daemon's expiry on this client's clock", () => {
    const receivedAt = 1_000_000
    // Same clocks: the daemon's 60 s.
    expect(previewGrantLocalExpiry(receivedAt / 1_000 + 60, receivedAt, 0)).toBe(receivedAt + 60_000)
    // This clock 55 s ahead, offset known: still 60 s from receipt.
    const daemonNow = receivedAt - 55_000
    expect(previewGrantLocalExpiry(daemonNow / 1_000 + 60, receivedAt, -55_000)).toBe(receivedAt + 60_000)
    // Offset unknown: never shorter than the floor, so no renewal loop.
    expect(previewGrantLocalExpiry(daemonNow / 1_000 + 60, receivedAt, 0)).toBe(receivedAt + previewGrantMinimumLifetimeMs)
    // This clock behind, offset known: the daemon's expiry, not a later one.
    const aheadDaemon = receivedAt + 120_000
    expect(previewGrantLocalExpiry(aheadDaemon / 1_000 + 60, receivedAt, 120_000)).toBe(receivedAt + 60_000)
  })

  it("backs off a failing renewal to one try every 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(previewGrantRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })
})
