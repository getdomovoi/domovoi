import { BlurView } from "expo-blur"
import { PixelRatio, useWindowDimensions, View, type LayoutChangeEvent, type ViewProps } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { cn } from "../lib/cn"
import { responsiveGeometry } from "../responsive-geometry"
import { shadows } from "../theme/tokens.generated"
import { useTheme } from "../theme/theme-provider"

// The handoff draws the bottom chrome eight times and draws it the same way
// every time: a floating slab inset from both edges, hairline border, a 60%
// wash of --sidebar over whatever is behind it, a 14px blur and a soft drop
// shadow. Only the corner radius and the padding change between the eight, so
// those are the props and everything else is fixed here.
//
// React Native has no backdrop-filter, so the blur is expo-blur's BlurView and
// the wash is painted on top of it.

export type FloatingBarShape = "pill" | "decision" | "card"
export type FloatingBarPadding = "tabs" | "bar" | "composer" | "stack"

const shapes: Record<FloatingBarShape, string> = {
  pill: "rounded-full",
  // 30 and 24 are the handoff's own values. Neither is a radius token: the
  // token scale tops out at 14px, which is a card's corner rather than a
  // floating slab's.
  decision: "rounded-[30px]",
  card: "rounded-[24px]",
}

const paddings: Record<FloatingBarPadding, string> = {
  tabs: "flex-row items-start px-1.5 py-2",
  bar: "flex-row items-center gap-2.5 py-2 pl-4 pr-2",
  composer: "flex-row items-center gap-2 py-1.5 pl-1 pr-1.5",
  stack: "gap-2 p-2.5",
}

export const floatingBarInset = 14
export const floatingBarSide = 14

export function FloatingBar({
  shape = "pill",
  padding = "composer",
  lifted = false,
  bottomInset,
  onFootprint,
  className,
  children,
  ...props
}: ViewProps & {
  shape?: FloatingBarShape
  padding?: FloatingBarPadding
  // The decision and denial bars carry a second, ambient shadow underneath the
  // dropped one, because they sit over a scrolling wall of diff rather than
  // over a list and have to read as a separate plane.
  lifted?: boolean
  bottomInset?: number | undefined
  // A bar floats over the scroller, so the scroller has to be told how much of
  // its own bottom the bar is covering. This reports the drawn height plus the
  // gap under it; a screen that scrolls underneath must pad by at least that
  // much or its last row can never be read. The home indicator is not a bar
  // and is not part of this: three screens in the handoff float nothing and
  // reserve nothing.
  onFootprint?: ((footprint: number) => void) | undefined
}) {
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const { resolved } = useTheme()
  const geometry = responsiveGeometry({
    width: window.width,
    height: window.height,
    topInset: insets.top,
    bottomInset: insets.bottom,
    fontScale: PixelRatio.getFontScale(),
  })
  const bottom = bottomInset ?? geometry.bottomInset
  const shadow = shadows[resolved].lg

  const measure = (event: LayoutChangeEvent) => {
    onFootprint?.(event.nativeEvent.layout.height + bottom)
  }

  return (
    <View
      {...props}
      onLayout={onFootprint ? measure : undefined}
      style={{
        position: "absolute",
        left: geometry.sideInset,
        right: geometry.sideInset,
        bottom,
        minHeight: geometry.minimumBarHeight,
        zIndex: 4,
        shadowColor: shadow.shadowColor,
        shadowOpacity: lifted ? Math.min(1, shadow.shadowOpacity + 0.06) : shadow.shadowOpacity,
        shadowRadius: shadow.shadowRadius,
        shadowOffset: shadow.shadowOffset,
        elevation: lifted ? shadow.elevation + 3 : shadow.elevation,
      }}
    >
      <View className={cn("overflow-hidden border border-border", shapes[shape])}>
        <BlurView
          intensity={30}
          tint={resolved}
          // Android draws nothing for a blur unless this method is asked for by
          // name. Where it is unavailable the wash below still carries the bar.
          blurMethod="dimezisBlurView"
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View className={cn("bg-sidebar/60", paddings[padding], className)}>
          {children}
        </View>
      </View>
    </View>
  )
}
