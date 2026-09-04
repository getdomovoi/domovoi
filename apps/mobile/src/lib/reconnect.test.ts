import { describe, expect, it } from "vitest"

import { firstRetryMs, maxRetryMs, retryDelayMs } from "./reconnect"

describe("retryDelayMs", () => {
  it("waits longer each time and then stops growing", () => {
    expect(retryDelayMs(1)).toBe(firstRetryMs)
    expect(retryDelayMs(2)).toBe(2_000)
    expect(retryDelayMs(3)).toBe(4_000)
    expect(retryDelayMs(20)).toBe(maxRetryMs)
  })

  it("does not wait before the first attempt", () => {
    expect(retryDelayMs(0)).toBe(0)
  })
})
