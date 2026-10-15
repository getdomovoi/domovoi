import { useEffect, useState } from "react"
import { Keyboard, useWindowDimensions, type KeyboardEvent } from "react-native"

// How far the keyboard reaches up into the window, in points, or 0 while it is
// down. A floating bar (the composer) is absolutely positioned, and padding
// added under its parent does not move an absolutely positioned child, so a
// KeyboardAvoidingView left the composer behind the keyboard while the thread
// above it shrank (F13, walk 2026-10-15). The screen lifts the bar by this
// much instead, and the thread pads by the bar's footprint as before.
//
// iOS only. iOS overlays the keyboard on a window that keeps its size; the
// will- events arrive before the keyboard moves, so the bar rides up with it.
// Android resizes the window for the keyboard (expo's default), so a bar at
// the window's bottom already sits above it; lifting it again would double the
// gap. That platform is not changed here and has not been checked on a device.
export function keyboardOverlap(event: KeyboardEvent, windowHeight: number): number {
  const { screenY, height } = event.endCoordinates
  return Math.max(0, Math.min(height, windowHeight - screenY))
}

export function useKeyboardLift(platform: string): number {
  const { height: windowHeight } = useWindowDimensions()
  const [lift, setLift] = useState(0)

  useEffect(() => {
    if (platform !== "ios") return undefined
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", (event) => setLift(keyboardOverlap(event, windowHeight))),
      Keyboard.addListener("keyboardWillChangeFrame", (event) => setLift(keyboardOverlap(event, windowHeight))),
      Keyboard.addListener("keyboardWillHide", () => setLift(0)),
    ]
    return () => { for (const subscription of subscriptions) subscription.remove() }
  }, [platform, windowHeight])

  return lift
}
