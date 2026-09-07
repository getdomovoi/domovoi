import { BlurView } from "expo-blur"
import { View, type LayoutChangeEvent, type ViewProps } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { cn } from "../lib/cn"

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

// The handoff floats the bar 22px above the bottom of the frame, which is
// exactly the height of the home indicator it draws. A real phone reports that
// room as a safe-area inset instead, and it is larger, so the inset wins where
// there is one and the drawn value stands in where there is not.
export const floatingBarInset = 22
export const floatingBarSide = 14

export function FloatingBar({
  shape = "pill",
  padding = "composer",
  lifted = false,
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
  // A bar floats over the scroller, so the scroller has to be told how much of
  // its own bottom the bar is covering. This reports the drawn height plus the
  // gap under it; a screen that scrolls underneath must pad by at least that
  // much or its last row can never be read. The home indicator is not a bar
  // and is not part of this: three screens in the handoff float nothing and
  // reserve nothing.
  onFootprint?: (footprint: number) => void
}) {
  const insets = useSafeAreaInsets()
  const bottom = insets.bottom > 0 ? insets.bottom : floatingBarInset

  const measure = (event: LayoutChangeEvent) => {
    onFootprint?.(event.nativeEvent.layout.height + bottom)
  }

  return (
    <View
      {...props}
      onLayout={onFootprint ? measure : undefined}
      style={{
        position: "absolute",
        left: floatingBarSide,
        right: floatingBarSide,
        bottom,
        zIndex: 4,
        // packages/ui carries an elevation scale, but scripts/mobile-tokens.mjs
        // renders only colours, radii and faces, so there is no shadow token to
        // read here. --shadow-lg resolves to black at 55%, which is what these
        // two values are; they are not a colour choice.
        shadowColor: "black",
        shadowOpacity: lifted ? 0.62 : 0.55,
        shadowRadius: lifted ? 16 : 12,
        shadowOffset: { width: 0, height: lifted ? 10 : 8 },
        elevation: lifted ? 16 : 12,
      }}
    >
      <View className={cn("overflow-hidden border border-border", shapes[shape])}>
        <BlurView
          intensity={30}
          tint="dark"
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
