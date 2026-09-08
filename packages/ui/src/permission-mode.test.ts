import type { Runtime } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  autoIsOffered,
  permissionModeLabel,
  permissionModes,
  withAuto,
  withPermissionMode,
} from "./permission-mode"

const base: Runtime = {
  provider: "claude-code",
  model: "claude-sonnet-4-6",
  reasoning: "high",
  permissionMode: "build",
  auto: true,
}

describe("permission modes", () => {
  it("offers exactly the three the protocol names", () => {
    expect(permissionModes.map((mode) => mode.id)).toEqual(["plan", "ask", "build"])
  })

  it("clears auto when the mode leaves build", () => {
    for (const mode of ["ask", "plan"] as const) {
      expect(withPermissionMode(base, mode).auto).toBe(false)
    }
  })

  it("keeps auto when the mode stays build", () => {
    expect(withPermissionMode(base, "build").auto).toBe(true)
  })

  it("refuses to turn auto on outside build", () => {
    const asking = withPermissionMode(base, "ask")
    expect(withAuto(asking, true)).toEqual(asking)
  })

  it("turns auto off from any mode", () => {
    expect(withAuto(base, false).auto).toBe(false)
  })

  it("offers the auto control only in build", () => {
    expect(autoIsOffered("build")).toBe(true)
    expect(autoIsOffered("ask")).toBe(false)
    expect(autoIsOffered("plan")).toBe(false)
  })

  it("says auto in the label only when it is on", () => {
    expect(permissionModeLabel("build", true)).toBe("Build · auto")
    expect(permissionModeLabel("build", false)).toBe("Build")
    expect(permissionModeLabel("ask", false)).toBe("Ask")
  })
})
