import { describe, expect, it, jest } from "@jest/globals"
import { Keyboard, type KeyboardEvent } from "react-native"
import { renderHook } from "@testing-library/react-native"

import { keyboardOverlap, useKeyboardLift } from "./use-keyboard-lift"

function at(screenY: number, height: number): KeyboardEvent {
  return {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { screenX: 0, screenY, width: 390, height },
    startCoordinates: { screenX: 0, screenY: 844, width: 390, height },
    isEventFromThisApp: true,
  }
}

describe("keyboardOverlap", () => {
  it("is how far a docked keyboard reaches into the window", () => {
    expect(keyboardOverlap(at(844 - 336, 336), 844)).toBe(336)
  })

  it("is nothing for a keyboard that ends below the window", () => {
    expect(keyboardOverlap(at(844, 336), 844)).toBe(0)
  })

  it("never reaches further than the keyboard is tall", () => {
    expect(keyboardOverlap(at(100, 336), 844)).toBe(336)
  })
})

describe("useKeyboardLift", () => {
  // Android resizes the window for the keyboard, so a bar at its bottom is
  // already above it; listening there would lift the bar twice.
  it("does not listen on Android", async () => {
    const listen = jest.spyOn(Keyboard, "addListener")
    try {
      const hook = await renderHook(() => useKeyboardLift("android"))
      expect(listen).not.toHaveBeenCalled()
      expect(hook.result.current).toBe(0)
    } finally {
      listen.mockRestore()
    }
  })

  it("stops listening when the screen goes", async () => {
    const remove = jest.fn()
    const listen = jest.spyOn(Keyboard, "addListener").mockReturnValue({ remove } as never)
    try {
      const hook = await renderHook(() => useKeyboardLift("ios"))
      expect(listen).toHaveBeenCalledTimes(3)
      await hook.unmount()
      expect(remove).toHaveBeenCalledTimes(3)
    } finally {
      listen.mockRestore()
    }
  })
})
