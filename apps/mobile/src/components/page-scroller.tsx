import { useState } from "react"
import {
  ScrollView,
  type LayoutChangeEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native"

import { scrollerScrolls } from "../scroller-overflow"

// Every screen in this app is the same shape: a scroller with a floating bar
// over it. This owns both halves of that, so a screen written later gets them
// without having to remember either.
//
// It reserves the bar's footprint itself rather than leaving it to the caller,
// which is also what makes the overflow test right: the padding is part of the
// content box, so a screen that only fits because the bar was ignored still
// scrolls.
export function PageScroller({
  bottomInset = 0,
  contentContainerStyle,
  ...props
}: ScrollViewProps & {
  // What FloatingBar reported covering. Zero on a screen with no bar over it.
  bottomInset?: number
}) {
  const [viewport, setViewport] = useState<number | undefined>(undefined)
  const [content, setContent] = useState<number | undefined>(undefined)

  // Measured on every layout and every content change rather than once, so a
  // list that starts empty and receives its first row turns scrolling back on
  // where it stands instead of needing to be rebuilt.
  const scrolls = scrollerScrolls({
    content,
    viewport,
    pullToRefresh: props.refreshControl !== undefined,
  })

  const measureViewport = (event: LayoutChangeEvent) => {
    setViewport(event.nativeEvent.layout.height)
    props.onLayout?.(event)
  }

  const measureContent = (width: number, height: number) => {
    setContent(height)
    props.onContentSizeChange?.(width, height)
  }

  const padding: StyleProp<ViewStyle> = [{ paddingBottom: bottomInset }, contentContainerStyle]

  return (
    <ScrollView
      {...props}
      onLayout={measureViewport}
      onContentSizeChange={measureContent}
      // The design system hides scrollbars on touch outright, under
      // "@media (hover: none), (pointer: coarse)": the platform overlays its
      // own indicator, so a second one drawn by the app is a defect rather than
      // a preference. Set here so it holds for every screen at once.
      showsVerticalScrollIndicator={false}
      scrollEnabled={scrolls}
      // iOS bounces vertically whether or not scrolling is enabled, so turning
      // the scroll off is not enough on its own to stop the rubber band.
      alwaysBounceVertical={scrolls}
      contentContainerStyle={padding}
    />
  )
}
