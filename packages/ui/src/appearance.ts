import { useEffect } from "react"

export type WorkspaceTheme = "system" | "dark" | "light"
export type ResolvedAppearanceTheme = "dark" | "light"

const workspaceThemes = new Set<WorkspaceTheme>(["system", "dark", "light"])

export const prefersDarkQuery = "(prefers-color-scheme: dark)"

export function isWorkspaceTheme(value: unknown): value is WorkspaceTheme {
  return typeof value === "string" && workspaceThemes.has(value as WorkspaceTheme)
}

export function workspaceThemeLabel(theme: WorkspaceTheme): string {
  if (theme === "dark") return "Dark"
  if (theme === "light") return "Light"
  return "System"
}

export function resolveAppearanceTheme(
  theme: WorkspaceTheme,
  prefersDark: boolean,
): ResolvedAppearanceTheme {
  if (theme === "dark") return "dark"
  if (theme === "light") return "light"
  return prefersDark ? "dark" : "light"
}

export function applyAppearanceTheme(element: Element, resolved: ResolvedAppearanceTheme): void {
  element.classList.toggle("dark", resolved === "dark")
  element.classList.toggle("light", resolved === "light")
}

type ColorSchemeQuery = {
  matches: boolean
  addEventListener?: (event: "change", listener: () => void) => void
  removeEventListener?: (event: "change", listener: () => void) => void
}

export function colorSchemeQuery(): ColorSchemeQuery | undefined {
  try {
    return globalThis.matchMedia?.(prefersDarkQuery) as ColorSchemeQuery | undefined
  } catch {
    return undefined
  }
}

export function themeRootElement(): Element | undefined {
  return globalThis.document?.documentElement ?? undefined
}

export function useAppearanceTheme(theme: WorkspaceTheme): void {
  useEffect(() => {
    const element = themeRootElement()
    if (!element) return
    const query = colorSchemeQuery()
    const apply = () => applyAppearanceTheme(
      element,
      resolveAppearanceTheme(theme, query?.matches ?? true),
    )
    apply()
    if (theme !== "system" || !query?.addEventListener || !query.removeEventListener) return
    const listener = () => apply()
    query.addEventListener("change", listener)
    return () => query.removeEventListener?.("change", listener)
  }, [theme])
}
