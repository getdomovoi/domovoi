import { Pressable, type PressableProps } from "react-native"

import { cn } from "../../lib/cn"
import { Text } from "./text"

type Variant = "primary" | "affirm" | "deny" | "outline" | "ghost" | "quiet" | "destructive"

// The handoff draws two shapes. A pill is an action beside a heading, where it
// has to read as a control without taking the width of one. A block is an
// action at the foot of a screen, where a thumb is aiming at the whole row.
// A slab at the foot of a floating bar is the handoff's third shape: full
// width like a block, but pill-cornered like the bar it sits inside.
type Shape = "pill" | "block" | "wide"

const surface: Record<Variant, string> = {
  primary: "bg-primary",
  // The screen that decides whether a command runs colours its affirmative
  // action with the same warning the request wears, so nothing on it reads as
  // the safe default.
  affirm: "bg-warning",
  // The screen that sends a refusal colours the send with the refusal, the
  // same way the screen that allows one colours the allow with the warning.
  deny: "bg-destructive",
  outline: "border border-border bg-transparent",
  ghost: "bg-transparent",
  // The second of two refusals. It reads as the quieter one because it costs
  // more to give: the reason has to be written before it can be sent.
  quiet: "border border-border bg-transparent",
  destructive: "border border-destructive bg-transparent",
}

const label: Record<Variant, string> = {
  primary: "text-primary-foreground",
  affirm: "text-warning-foreground",
  deny: "text-destructive-foreground",
  outline: "text-strong",
  ghost: "text-primary",
  quiet: "text-muted-foreground",
  destructive: "text-destructive",
}

const shapes: Record<Shape, string> = {
  pill: "rounded-full px-3.5",
  block: "w-full rounded-xl px-4 py-3.5",
  wide: "w-full rounded-full px-4 py-3.5",
}

export function Button({
  title,
  variant = "outline",
  shape = "pill",
  disabled,
  className,
  ...props
}: PressableProps & { title: string, variant?: Variant, shape?: Shape }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      // 44pt is the iOS minimum and the handoff states it, so it is enforced on
      // the control rather than left to each screen to remember.
      className={cn(
        "min-h-tap min-w-tap items-center justify-center",
        shapes[shape],
        surface[variant],
        disabled && "opacity-40",
        className,
      )}
      {...props}
    >
      <Text className={cn(
        "font-sans-medium",
        shape === "pill" ? "text-[12px]" : "text-[13px]",
        label[variant],
      )}>
        {title}
      </Text>
    </Pressable>
  )
}
