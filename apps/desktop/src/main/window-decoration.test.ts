import { describe, expect, it, vi } from "vitest"

import {
  isWindowDecoration,
  readWindowDecoration,
  serializeWindowDecoration,
  windowFrameOptions,
} from "./window-decoration.js"
import { titlebarLeadingInset } from "../shared/traffic-lights.js"

describe("window decoration preference", () => {
  it("accepts only the two supported decorations", () => {
    expect(isWindowDecoration("domovoi")).toBe(true)
    expect(isWindowDecoration("system")).toBe(true)
    expect(isWindowDecoration("gnome")).toBe(false)
    expect(isWindowDecoration(undefined)).toBe(false)
  })

  it("round-trips the stored preference", () => {
    const stored = serializeWindowDecoration("system")
    expect(readWindowDecoration(() => stored)).toBe("system")
  })

  it("falls back to the Domovoi decoration for missing or corrupt state", () => {
    expect(readWindowDecoration(() => { throw new Error("ENOENT") })).toBe("domovoi")
    expect(readWindowDecoration(() => "{")).toBe("domovoi")
    expect(readWindowDecoration(() => JSON.stringify({ version: 1, decoration: "gnome" }))).toBe("domovoi")
    expect(readWindowDecoration(() => JSON.stringify({ version: 9, decoration: "system" }))).toBe("domovoi")
  })

  it("keeps the Domovoi frame options the desktop shipped with", () => {
    expect(windowFrameOptions("domovoi", "darwin")).toEqual({
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 14 },
    })
    expect(windowFrameOptions("domovoi", "linux")).toEqual({
      frame: false,
      titleBarStyle: "hidden",
    })
  })

  it("derives the titlebar inset from the light position and reserves none elsewhere", () => {
    // 16 to the first light, three 12px lights with two 8px gaps, then the
    // design's 16px clearance before the mark.
    expect(titlebarLeadingInset("darwin")).toBe(84)
    expect(titlebarLeadingInset("linux")).toBe(0)
    expect(titlebarLeadingInset("win32")).toBe(0)
  })

  it("hands the frame back to the operating system when asked", () => {
    expect(windowFrameOptions("system", "darwin")).toEqual({
      frame: true,
      titleBarStyle: "default",
    })
    expect(windowFrameOptions("system", "win32")).toEqual({
      frame: true,
      titleBarStyle: "default",
    })
  })

  it("reads the file once per call and never throws at the caller", () => {
    const readFile = vi.fn(() => { throw new Error("EACCES") })
    expect(readWindowDecoration(readFile)).toBe("domovoi")
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})
