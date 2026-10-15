import { useEffect, useState } from "react"
import { Keyboard, useWindowDimensions, type KeyboardEvent } from "react-native"

// How far the keyboard reaches up from the window's bottom edge, in points,
// or 0 while it is down. A floating bar (the composer) is absolutely
// positioned, and the padding a KeyboardAvoidingView adds does not move an
// absolutely positioned child, so the composer stayed under the keyboard while
// the thread above it shrank (F13, walk 2026-10-15). The session screen lifts
// the bar by this much while the composer has the keyboard.
//
// iOS overlays the keyboard on a window that keeps its size and reports where
// the keyboard's top lands in window coordinates; the will- events arrive
// before the keyboard moves, so the bar is scheduled to move with it.
//
// Android draws edge to edge (app.json edgeToEdgeEnabled), so the window runs
// under the navigation bar and is not resized for the keyboard. React Native
// reports the keyboard's height above the system bars, so the reach from the
// window's bottom adds the navigation bar's inset. Android has only did-
// events. Neither platform has been checked on a device for this change.
export function keyboardReach(platform: string, event: KeyboardEvent, windowHeight: number, bottomInset: number): number {
  const { screenY, height } = event.endCoordinates
  if (platform === "android") return height > 0 ? height + bottomInset : 0
  return Math.max(0, Math.min(height, windowHeight - screenY))
}

const events: Record<string, { show: readonly KeyboardEventName[], hide: KeyboardEventName }> = {
  ios: { show: ["keyboardWillShow", "keyboardWillChangeFrame"], hide: "keyboardWillHide" },
  android: { show: ["keyboardDidShow"], hide: "keyboardDidHide" },
}

type KeyboardEventName = "keyboardWillShow" | "keyboardWillChangeFrame" | "keyboardWillHide" | "keyboardDidShow" | "keyboardDidHide"

export function useKeyboardReach(platform: string, bottomInset: number): number {
  const { height: windowHeight } = useWindowDimensions()
  const [reach, setReach] = useState(0)

  useEffect(() => {
    const names = events[platform]
    if (!names) return undefined
    const move = (event: KeyboardEvent, next: number) => {
      // Animates the layout this change causes on the keyboard's own curve.
      if (platform === "ios") Keyboard.scheduleLayoutAnimation(event)
      setReach(next)
    }
    const subscriptions = [
      ...names.show.map((name) => Keyboard.addListener(name, (event) => move(event, keyboardReach(platform, event, windowHeight, bottomInset)))),
      Keyboard.addListener(names.hide, (event) => move(event, 0)),
    ]
    return () => { for (const subscription of subscriptions) subscription.remove() }
  }, [platform, windowHeight, bottomInset])

  return reach
}
