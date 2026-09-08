import { Pressable, View, type PressableProps, type ViewProps } from "react-native"

import { cn } from "../../lib/cn"

// The handoff sets every card at the shared radius token with 12pt of room top
// and bottom and 13pt at the sides. A card that holds rows rather than prose
// carries no padding of its own, because each row brings its own.
const base = "rounded-xl border border-border bg-card"
const padding = "px-[13px] py-3"

export function Card({ flush, className, ...props }: ViewProps & { flush?: boolean }) {
  return <View className={cn(base, !flush && padding, className)} {...props} />
}

// A card that does something is a button, and screen readers are told so rather
// than being handed a view that happens to respond to taps.
export function PressableCard({
  flush,
  className,
  ...props
}: PressableProps & { flush?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(base, !flush && padding, "active:opacity-70", className)}
      {...props}
    />
  )
}
