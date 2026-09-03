import { describe, expect, it } from "vitest"

import { isWorkspaceTheme, resolveAppearanceTheme } from "./appearance"

describe("appearance theme", () => {
  it("accepts only the three supported themes", () => {
    expect(["system", "dark", "light"].every(isWorkspaceTheme)).toBe(true)
    expect(isWorkspaceTheme("solarized")).toBe(false)
    expect(isWorkspaceTheme(undefined)).toBe(false)
  })

  it("follows the operating system only when the theme is system", () => {
    expect(resolveAppearanceTheme("system", true)).toBe("dark")
    expect(resolveAppearanceTheme("system", false)).toBe("light")
    expect(resolveAppearanceTheme("dark", false)).toBe("dark")
    expect(resolveAppearanceTheme("light", true)).toBe("light")
  })
})
