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

// The flip between light and dark animates: 200ms on --ease-out across the
// colour properties, collapsed by prefers-reduced-motion. It is armed for the
// flip and removed after, never standing: a permanent transition on every
// element would also fade hover backgrounds, and the design system's hover is
// an instant step to --accent. The class goes on in the same call that
// changes the theme; a frame later would miss the flip.
export const themeFlipMs = 240
const flipTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

export function applyAppearanceTheme(element: Element, resolved: ResolvedAppearanceTheme): void {
  const current = element.classList.contains("dark") ? "dark" : element.classList.contains("light") ? "light" : undefined
  if (current !== undefined && current !== resolved) {
    element.classList.add("dv-theming")
    const pending = flipTimers.get(element)
    if (pending !== undefined) clearTimeout(pending)
    flipTimers.set(element, setTimeout(() => {
      element.classList.remove("dv-theming")
      flipTimers.delete(element)
    }, themeFlipMs))
  }
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
