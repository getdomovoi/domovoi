import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { Platform, View, type ViewProps } from "react-native"
import { BlurTargetView } from "expo-blur"

import { useTheme } from "../theme/theme-provider"

// Android has no window-level backdrop blur. expo-blur's Android BlurView
// blurs one named view, its blurTarget, and with no target it draws no blur at
// all. A floating bar has to be told which view it floats over, and that view
// is usually not its parent: the tab bar sits beside the screen it covers, and
// the composer sits beside the thread. So a backdrop registers its view with
// the nearest provider, and every bar under that provider reads it from there.
//
// A blur must never sample a view it is drawn inside, or it would sample
// itself. A backdrop therefore hides the target from everything drawn inside
// it: a bar placed inside one gets no target and falls back to its wash.
//
// iOS blurs whatever is behind the bar without being told, so none of this is
// used there and the backdrop is a plain view.

type Backdrop = {
  target: View | null
  register: (node: View) => void
  release: (node: View) => void
}

const BackdropContext = createContext<Backdrop | undefined>(undefined)

export function BlurBackdropProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<View | null>(null)
  const register = useCallback((node: View) => setTarget(node), [])
  // Only the backdrop that is registered may clear it. When one screen
  // replaces another, the new backdrop can register before the old one goes.
  const release = useCallback((node: View) => setTarget((current) => (current === node ? null : current)), [])
  const value = useMemo(() => ({ target, register, release }), [target, register, release])
  return <BackdropContext.Provider value={value}>{children}</BackdropContext.Provider>
}

// Takes style rather than className: NativeWind maps className only on the
// components it knows, and expo-blur's target view is not one of them.
export function BlurBackdrop({ children, style, ...props }: Omit<ViewProps, "className">) {
  const backdrop = useContext(BackdropContext)
  const { palette } = useTheme()
  const register = backdrop?.register
  const release = backdrop?.release
  const target = useRef<View>(null)

  // A layout effect runs after the target's ref is attached and before the
  // frame is drawn, so a bar never draws a frame pointed at nothing.
  useLayoutEffect(() => {
    const node = target.current
    if (!node || !register || !release) return
    register(node)
    return () => release(node)
  }, [register, release])

  if (Platform.OS !== "android") return <View {...props} style={style}>{children}</View>
  // The blur samples only what the target draws. Where the target is
  // transparent the sample is filled with the window's own background, which
  // follows the system theme rather than the one picked in Settings, so the
  // target paints the app background itself.
  return (
    <BlurTargetView {...props} style={[{ backgroundColor: palette.background }, style]} ref={target}>
      <BackdropContext.Provider value={undefined}>{children}</BackdropContext.Provider>
    </BlurTargetView>
  )
}

// What a FloatingBar passes to its BlurView. A new object each time the target
// changes, because expo-blur looks the target up again only when the ref it is
// given holds a different view than the one before.
export function useBlurTarget(): RefObject<View | null> | undefined {
  const backdrop = useContext(BackdropContext)
  const target = backdrop?.target ?? null
  const inside = backdrop !== undefined
  return useMemo(
    () => (Platform.OS === "android" && inside ? { current: target } : undefined),
    [inside, target],
  )
}
