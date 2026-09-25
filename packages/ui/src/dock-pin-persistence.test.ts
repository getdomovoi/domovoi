import { describe, expect, it } from "vitest"

import { defaultWorkspaceUiState, loadWorkspaceUiState, saveWorkspaceUiState } from "./workspace-persistence"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  } as Storage
}

// A pin is a standing choice about the layout, so a reload has to honour it.
describe("dock pin persistence", () => {
  it("keeps an open pinned dock across a reload", () => {
    const storage = memoryStorage()
    saveWorkspaceUiState(storage, { ...defaultWorkspaceUiState(), dockCollapsed: false, dockPinned: true })
    const reloaded = loadWorkspaceUiState(storage)
    expect({ collapsed: reloaded.dockCollapsed, pinned: reloaded.dockPinned })
      .toEqual({ collapsed: false, pinned: true })
  })
})
