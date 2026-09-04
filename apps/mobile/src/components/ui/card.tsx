import { Pressable, View, type PressableProps, type ViewProps } from "react-native"

import { cn } from "../../lib/cn"

const base = "rounded-lg border border-border bg-card p-3.5"

export function Card({ className, ...props }: ViewProps) {
  return <View className={cn(base, className)} {...props} />
}

// A card that does something is a button, and screen readers are told so rather
// than being handed a view that happens to respond to taps.
export function PressableCard({ className, ...props }: PressableProps) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(base, "active:opacity-70", className)}
      {...props}
    />
  )
}
