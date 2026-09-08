import { describe, expect, it } from "vitest"

import { defaultWorkspaceUiState, parseWorkspaceUiState } from "./workspace-persistence"

describe("where the machine surfaces live", () => {
  it("starts as a sheet over the thread rather than a pinned panel", () => {
    // v2 removed the permanent inspector. The surfaces are still one keystroke
    // away, but they are borrowed space until someone pins them.
    expect(defaultWorkspaceUiState().dockPinned).toBe(false)
  })

  it("remembers a pin across restarts", () => {
    const state = { ...defaultWorkspaceUiState(), dockPinned: true }
    expect(parseWorkspaceUiState(JSON.parse(JSON.stringify(state)))?.dockPinned).toBe(true)
  })

  it("reads a pre-v2 state as unpinned rather than refusing it", () => {
    // Every state written before this field existed omits it, and a person who
    // had the dock open should not lose their layout to a parse failure.
    const legacy = { ...defaultWorkspaceUiState() } as Record<string, unknown>
    delete legacy.dockPinned
    const parsed = parseWorkspaceUiState(legacy)
    expect(parsed).toBeTruthy()
    expect(parsed?.dockPinned).toBe(false)
  })
})
