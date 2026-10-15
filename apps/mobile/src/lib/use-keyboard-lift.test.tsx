import { describe, expect, it, jest } from "@jest/globals"
import { Dimensions, Keyboard, type KeyboardEvent } from "react-native"
import { act, renderHook } from "@testing-library/react-native"

import { keyboardReach, useKeyboardReach } from "./use-keyboard-lift"

function at(screenY: number, height: number): KeyboardEvent {
  return {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { screenX: 0, screenY, width: 390, height },
    startCoordinates: { screenX: 0, screenY: 844, width: 390, height },
    isEventFromThisApp: true,
  }
}

type Handler = (event: KeyboardEvent) => void

function listen() {
  const handlers = new Map<string, Handler>()
  const remove = jest.fn()
  const spy = jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, handler: Handler) => {
    handlers.set(name, handler)
    return { remove }
  }) as unknown as typeof Keyboard.addListener)
  const emit = async (name: string, event: KeyboardEvent) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`nothing listens for ${name}`)
    await act(async () => { handler(event) })
  }
  return { spy, remove, handlers, emit }
}

describe("keyboardReach", () => {
  it("is how far a docked iOS keyboard reaches into the window", () => {
    expect(keyboardReach("ios", at(844 - 336, 336), 844, 34)).toBe(336)
  })

  it("is nothing for an iOS keyboard that ends below the window", () => {
    expect(keyboardReach("ios", at(844, 336), 844, 34)).toBe(0)
  })

  it("never reaches further than the iOS keyboard is tall", () => {
    expect(keyboardReach("ios", at(100, 336), 844, 34)).toBe(336)
  })

  // Android reports the keyboard's height above the system bars, and an
  // edge-to-edge window runs under the navigation bar, so the keyboard reaches
  // up from the window's bottom by its height plus that inset.
  it("adds the navigation bar under an Android keyboard", () => {
    expect(keyboardReach("android", at(500, 300), 900, 24)).toBe(324)
    expect(keyboardReach("android", at(900, 0), 900, 24)).toBe(0)
  })
})

describe("useKeyboardReach", () => {
  it("follows the iOS keyboard's will- events and animates with it", async () => {
    const keyboard = listen()
    const schedule = jest.spyOn(Keyboard, "scheduleLayoutAnimation").mockImplementation(() => {})
    try {
      const hook = await renderHook(() => useKeyboardReach("ios", 34))
      expect([...keyboard.handlers.keys()].sort()).toEqual(["keyboardWillChangeFrame", "keyboardWillHide", "keyboardWillShow"])
      const window = Dimensions.get("window").height
      await keyboard.emit("keyboardWillShow", at(window - 336, 336))
      expect(hook.result.current).toBe(336)
      expect(schedule).toHaveBeenCalledTimes(1)
      await keyboard.emit("keyboardWillHide", at(window, 0))
      expect(hook.result.current).toBe(0)
      expect(schedule).toHaveBeenCalledTimes(2)
      await hook.unmount()
      expect(keyboard.remove).toHaveBeenCalledTimes(3)
    } finally {
      schedule.mockRestore()
      keyboard.spy.mockRestore()
    }
  })

  it("follows the Android keyboard's did- events", async () => {
    const keyboard = listen()
    try {
      const hook = await renderHook(() => useKeyboardReach("android", 24))
      expect([...keyboard.handlers.keys()].sort()).toEqual(["keyboardDidHide", "keyboardDidShow"])
      await keyboard.emit("keyboardDidShow", at(500, 300))
      expect(hook.result.current).toBe(324)
      await keyboard.emit("keyboardDidHide", at(900, 0))
      expect(hook.result.current).toBe(0)
    } finally {
      keyboard.spy.mockRestore()
    }
  })
})
