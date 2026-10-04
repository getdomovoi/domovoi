import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"

import { WebPageHeader } from "./web-page-header.js"
import { defaultWorkspaceUiState, workspaceUiStorageKey } from "./workspace-persistence.js"

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove("dark", "light")
})

function memoryStorage(seed?: string): Storage {
  const held = new Map<string, string>(seed ? [[workspaceUiStorageKey, seed]] : [])
  return {
    get length() { return held.size },
    clear: () => held.clear(),
    getItem: (key) => held.get(key) ?? null,
    key: (index) => [...held.keys()][index] ?? null,
    removeItem: (key) => { held.delete(key) },
    setItem: (key, value) => { held.set(key, value) },
  }
}

// Q382 A: the pages before a session draw the Web v2 bar, the mark, the
// wordmark, the page's label and the theme toggle. The toggle keeps its
// choice where the workspace reads it, so the session opens in that theme.
it("draws the mark, Domovoi, the page label and a theme toggle that keeps its choice", async () => {
  const user = userEvent.setup()
  const storage = memoryStorage(JSON.stringify({ ...defaultWorkspaceUiState(), theme: "dark" }))
  render(<WebPageHeader label="Connect this browser" storage={storage} />)

  const bar = screen.getByRole("banner")
  expect(bar.textContent).toContain("Domovoi")
  expect(bar.textContent).toContain("Connect this browser")
  expect(document.documentElement.classList.contains("dark")).toBe(true)

  await user.click(screen.getByRole("button", { name: "Use light theme" }))
  expect(document.documentElement.classList.contains("light")).toBe(true)
  expect(JSON.parse(storage.getItem(workspaceUiStorageKey) ?? "{}")).toMatchObject({ theme: "light" })
  expect(screen.getByRole("button", { name: "Use dark theme" })).toBeTruthy()
})

// With the system theme, the toggle follows the system's appearance as it
// changes, so its label names the theme it will switch to.
it("follows a system appearance change while the theme is system", () => {
  const listeners = new Set<() => void>()
  const query = {
    matches: true,
    addEventListener: (_event: "change", listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_event: "change", listener: () => void) => { listeners.delete(listener) },
  }
  const original = globalThis.matchMedia
  globalThis.matchMedia = (() => query) as unknown as typeof globalThis.matchMedia
  try {
    render(<WebPageHeader label="Connect this browser" storage={memoryStorage(JSON.stringify({ ...defaultWorkspaceUiState(), theme: "system" }))} />)
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeTruthy()
    act(() => {
      query.matches = false
      for (const listener of listeners) listener()
    })
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeTruthy()
    expect(document.documentElement.classList.contains("light")).toBe(true)
  } finally {
    globalThis.matchMedia = original
  }
})

it("still toggles the theme when storage is unavailable", async () => {
  const user = userEvent.setup()
  render(<WebPageHeader label="What a tab can do" storage={null} />)
  const toggle = screen.getByRole("button", { name: /Use (light|dark) theme/ })
  const before = document.documentElement.classList.contains("dark")
  await user.click(toggle)
  expect(document.documentElement.classList.contains("dark")).toBe(!before)
})
