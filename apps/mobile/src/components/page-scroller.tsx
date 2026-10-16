import { forwardRef, useImperativeHandle, useRef, useState } from "react"
import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
// Within this many points of the end counts as at the bottom, so a momentum
// scroll that settles a hair short still follows.
const atEndSlack = 24
// A held growth is the layout that follows a tap, which lands within frames.
const holdWindowMs = 1_000

export type PageScrollerHandle = {
  // The ride back a jump pill offers: to the end, and following resumes.
  scrollToEnd: () => void
  // The next growth is the person's own doing, such as opening a card, and
  // following it would scroll what they opened out of view. Only that one
  // growth is held; what lands after it is followed as before.
  holdNextGrowth: () => void
}

export const PageScroller = forwardRef<PageScrollerHandle, ScrollViewProps & {
  // What FloatingBar reported covering. Zero on a screen with no bar over it.
  bottomInset?: number
  // A thread reads newest-last, and the person is waiting at the bottom for
  // what lands. When the content grows and the person is at the bottom, the
  // scroller goes to the end. Scrolled up, it holds still: they are reading,
  // and moving the viewport under them is the one moment it must not move.
  followEnd?: boolean
  // Fires when at-the-bottom flips, so a screen can offer the ride back.
  onAtEndChange?: (atEnd: boolean) => void
}>(function PageScroller({
  bottomInset = 0,
  followEnd = false,
  onAtEndChange,
  contentContainerStyle,
  ...props
}, handle) {
  const scroller = useRef<ScrollView>(null)
  const [viewport, setViewport] = useState<number | undefined>(undefined)
  const [content, setContent] = useState<number | undefined>(undefined)
  // Read from scroll events rather than derived from sizes: only the scroll
  // position says where the person put the viewport.
  const atEnd = useRef(true)
  // Until when the next growth is held. Bounded, so a hold whose growth never
  // comes does not swallow a reply that lands much later.
  const heldUntil = useRef(0)

  useImperativeHandle(handle, () => ({
    holdNextGrowth: () => { heldUntil.current = Date.now() + holdWindowMs },
    scrollToEnd: () => {
      scroller.current?.scrollToEnd({ animated: true })
      if (!atEnd.current) {
        atEnd.current = true
        onAtEndChange?.(true)
      }
    },
  }))

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent
    const next = contentOffset.y + layoutMeasurement.height >= contentSize.height - atEndSlack
    if (next !== atEnd.current) {
      atEnd.current = next
      onAtEndChange?.(next)
    }
    props.onScroll?.(event)
  }

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
    const grew = content === undefined || height > content
    if (grew && Date.now() < heldUntil.current) heldUntil.current = 0
    else if (followEnd && atEnd.current && grew) scroller.current?.scrollToEnd({ animated: true })
    setContent(height)
    props.onContentSizeChange?.(width, height)
  }

  const padding: StyleProp<ViewStyle> = [{ paddingBottom: bottomInset }, contentContainerStyle]

  return (
    <ScrollView
      {...props}
      ref={scroller}
      onLayout={measureViewport}
      onContentSizeChange={measureContent}
      onScroll={trackScroll}
      scrollEventThrottle={props.scrollEventThrottle ?? 48}
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
})
