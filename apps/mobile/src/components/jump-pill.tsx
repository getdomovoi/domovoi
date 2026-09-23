import { threadFollowPillText, type ThreadFollow } from "@getdomovoi/protocol"
import { useEffect, useRef, useState } from "react"
import { AccessibilityInfo, Animated, Pressable, View } from "react-native"

import { cn } from "../lib/cn"
import { Icon } from "./ui/icon"
import { Text } from "./ui/text"

// The ride back to the end of the thread, floating above the composer. The
// phone needs this more than the desktop does, not less: flicking back to the
// end of a long thread by hand is harder on a touch screen, so following only
// at the bottom without an offered ride would be worse than always following.
// 44px tall for a thumb. Two states: a primary dot with the count of what
// landed, or the warning ramp with a pulsing dot when a decision waits below.
export function JumpPill({
  state,
  unseen,
  above,
  onPress,
}: {
  state: ThreadFollow
  unseen: number
  // What the composer reported covering, so the pill sits just over it.
  above: number
  onPress: () => void
}) {
  const text = threadFollowPillText(state, unseen)
  if (!text) return null
  const gate = state === "gate"
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: above + 10, zIndex: 5, alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gate ? "Jump to the waiting decision" : unseen > 0 ? `Jump to the ${text}` : "Jump to the latest output"}
        onPress={onPress}
        className={cn(
          "h-11 flex-row items-center gap-2.5 rounded-full border px-[17px]",
          gate ? "border-warn-border bg-warn-bg" : "border-border bg-card",
        )}
        style={{ shadowColor: "black", shadowOpacity: 0.55, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 12 }}
      >
        <PulseDot pulsing={gate} className={gate ? "bg-warning" : "bg-primary"} />
        <Text className={cn("font-sans text-[13px]", gate ? "text-warn-fg" : "text-strong")}>{text}</Text>
        <Icon name="arrow-down" tone={gate ? "warn-fg" : "strong"} size={15} />
      </Pressable>
    </View>
  )
}

// The design system stops a loop under reduced motion rather than shortening
// it: a faster pulse is the opposite of what the preference asked for.
function PulseDot({ pulsing, className }: { pulsing: boolean; className: string }) {
  const scale = useRef(new Animated.Value(1)).current
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduced(value) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!pulsing || reduced) { scale.setValue(1); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.6, duration: 1200, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 1200, useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [pulsing, reduced, scale])
  return <Animated.View className={cn("size-[7px] rounded-full", className)} style={{ transform: [{ scale }] }} />
}
