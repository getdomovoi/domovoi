import { describe, expect, it } from "vitest"

import { resolveTheme, themeColorVariables } from "./theme"
import { colors } from "./tokens.generated"

describe("mobile theme", () => {
  it("resolves light, dark and system choices", () => {
    expect(resolveTheme("light", "dark")).toBe("light")
    expect(resolveTheme("dark", "light")).toBe("dark")
    expect(resolveTheme("system", "light")).toBe("light")
    expect(resolveTheme("system", null)).toBe("dark")
  })

  it("builds each runtime palette from generated tokens", () => {
    const light = themeColorVariables("light")
    const dark = themeColorVariables("dark")
    expect(light["--color-background"]).toBe("251 250 248")
    expect(dark["--color-background"]).toBe("14 14 16")
    expect(Object.keys(light)).toHaveLength(Object.keys(colors.light).length)
    expect(Object.keys(dark)).toHaveLength(Object.keys(colors.dark).length)
  })
})
