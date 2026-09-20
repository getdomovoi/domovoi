import { describe, expect, it } from "vitest"

import { responsiveGeometry } from "./responsive-geometry"

describe("responsiveGeometry", () => {
  it("preserves signed iOS 390 by 844 safe-area geometry", () => {
    expect(responsiveGeometry({ width: 390, height: 844, topInset: 59, bottomInset: 34, fontScale: 1 })).toEqual({
      sideInset: 14,
      bottomInset: 34,
      keyboardOffset: 59,
      minimumBarHeight: 54,
    })
  })

  it("preserves signed Android 412 by 892 geometry", () => {
    expect(responsiveGeometry({ width: 412, height: 892, topInset: 24, bottomInset: 0, fontScale: 1 })).toEqual({
      sideInset: 14,
      bottomInset: 14,
      keyboardOffset: 24,
      minimumBarHeight: 54,
    })
  })

  it("keeps compact widths usable and grows chrome for dynamic type", () => {
    expect(responsiveGeometry({ width: 320, height: 568, topInset: 20, bottomInset: 0, fontScale: 1.6 })).toEqual({
      sideInset: 10,
      bottomInset: 10,
      keyboardOffset: 20,
      minimumBarHeight: 76,
    })
  })
})
