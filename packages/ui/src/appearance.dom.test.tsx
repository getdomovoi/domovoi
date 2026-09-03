import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { applyAppearanceTheme, useAppearanceTheme, type WorkspaceTheme } from "./appearance"
import {
  applyStoredAppearanceTheme,
  defaultWorkspaceUiState,
  saveWorkspaceUiState,
} from "./workspace-persistence"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove("dark", "light")
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

function stubColorScheme(initial: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: initial,
    addEventListener: (_event: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener) },
  }
  vi.stubGlobal("matchMedia", vi.fn(() => query))
  return {
    listeners,
    change(matches: boolean) {
      query.matches = matches
      for (const listener of [...listeners]) listener()
    },
  }
}

function Probe({ theme }: { theme: WorkspaceTheme }) {
  useAppearanceTheme(theme)
  return null
}

it("selects exactly one palette scope on the element", () => {
  const element = document.createElement("div")

  applyAppearanceTheme(element, "light")
  expect(element.classList.contains("dark")).toBe(false)
  expect(element.classList.contains("light")).toBe(true)

  applyAppearanceTheme(element, "dark")
  expect(element.classList.contains("dark")).toBe(true)
  expect(element.classList.contains("light")).toBe(false)
})

it("follows a live operating-system change while the theme is system", () => {
  const media = stubColorScheme(true)
  render(<Probe theme="system" />)
  expect(document.documentElement.classList.contains("dark")).toBe(true)

  media.change(false)
  expect(document.documentElement.classList.contains("light")).toBe(true)
  expect(document.documentElement.classList.contains("dark")).toBe(false)
})

it("pins an explicit theme and releases the operating-system listener", () => {
  const media = stubColorScheme(true)
  const view = render(<Probe theme="light" />)
  expect(document.documentElement.classList.contains("light")).toBe(true)
  expect(media.listeners.size).toBe(0)

  view.rerender(<Probe theme="system" />)
  expect(document.documentElement.classList.contains("dark")).toBe(true)
  expect(media.listeners.size).toBe(1)

  view.unmount()
  expect(media.listeners.size).toBe(0)
})

it("applies the stored theme before the workspace renders", () => {
  stubColorScheme(true)
  const storage = memoryStorage()
  saveWorkspaceUiState(storage, { ...defaultWorkspaceUiState(), theme: "light" })

  applyStoredAppearanceTheme(storage)

  expect(document.documentElement.classList.contains("light")).toBe(true)
  expect(document.documentElement.classList.contains("dark")).toBe(false)
})
