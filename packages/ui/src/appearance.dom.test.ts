import { afterEach, describe, expect, it, vi } from "vitest"

import { applyAppearanceTheme, themeFlipMs } from "./appearance"

afterEach(() => { vi.useRealTimers() })

describe("theme flip", () => {
  // The flip animates, and only the flip. A standing transition on every
  // element would also fade hover backgrounds, and the design system's hover
  // is an instant step to --accent, so the class is armed in the same call
  // that changes the theme and removed once the transition has run.
  it("arms the flip class in the same call as a theme change, and drops it after the flip", () => {
    vi.useFakeTimers()
    const element = document.createElement("div")
    applyAppearanceTheme(element, "dark")
    expect(element.classList.contains("dv-theming")).toBe(false)
    applyAppearanceTheme(element, "light")
    expect(element.classList.contains("light")).toBe(true)
    expect(element.classList.contains("dv-theming")).toBe(true)
    vi.advanceTimersByTime(themeFlipMs - 1)
    expect(element.classList.contains("dv-theming")).toBe(true)
    vi.advanceTimersByTime(1)
    expect(element.classList.contains("dv-theming")).toBe(false)
  })

  it("does not animate the first paint or a repeat of the same theme", () => {
    vi.useFakeTimers()
    const element = document.createElement("div")
    applyAppearanceTheme(element, "light")
    expect(element.classList.contains("dv-theming")).toBe(false)
    applyAppearanceTheme(element, "light")
    expect(element.classList.contains("dv-theming")).toBe(false)
  })

  it("keeps the class armed across a second flip inside the window", () => {
    vi.useFakeTimers()
    const element = document.createElement("div")
    applyAppearanceTheme(element, "dark")
    applyAppearanceTheme(element, "light")
    vi.advanceTimersByTime(themeFlipMs - 40)
    applyAppearanceTheme(element, "dark")
    vi.advanceTimersByTime(40)
    expect(element.classList.contains("dv-theming")).toBe(true)
    vi.advanceTimersByTime(themeFlipMs - 40)
    expect(element.classList.contains("dv-theming")).toBe(false)
  })
})
