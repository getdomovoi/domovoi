import { colors } from "./tokens.generated"

export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export function resolveTheme(preference: ThemePreference, system: string | null | undefined): ResolvedTheme {
  if (preference !== "system") return preference
  return system === "light" ? "light" : "dark"
}

function rgbChannels(hex: string): string {
  const value = hex.slice(1, 7)
  return `${Number.parseInt(value.slice(0, 2), 16)} ${Number.parseInt(value.slice(2, 4), 16)} ${Number.parseInt(value.slice(4, 6), 16)}`
}

export function themeColorVariables(theme: ResolvedTheme): Record<`--color-${string}`, string> {
  return Object.fromEntries(
    Object.entries(colors[theme]).map(([name, value]) => [`--color-${name}`, rgbChannels(value)]),
  ) as Record<`--color-${string}`, string>
}
