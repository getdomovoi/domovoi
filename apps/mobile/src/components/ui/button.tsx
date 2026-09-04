import { Pressable, type PressableProps } from "react-native"

import { cn } from "../../lib/cn"
import { Text } from "./text"

type Variant = "primary" | "outline" | "ghost" | "destructive"

const surface: Record<Variant, string> = {
  primary: "bg-primary",
  outline: "border border-border bg-card",
  ghost: "bg-transparent",
  destructive: "bg-destructive",
}

const label: Record<Variant, string> = {
  primary: "text-primary-foreground",
  outline: "text-strong",
  ghost: "text-strong",
  destructive: "text-foreground",
}

export function Button({
  title,
  variant = "outline",
  disabled,
  className,
  ...props
}: PressableProps & { title: string, variant?: Variant }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      // 44pt is the iOS minimum and the handoff states it, so it is enforced on
      // the control rather than left to each screen to remember.
      className={cn(
        "min-h-tap min-w-tap items-center justify-center rounded-full px-4",
        surface[variant],
        disabled && "opacity-40",
        className,
      )}
      {...props}
    >
      <Text variant="title" className={cn("text-[14px]", label[variant])}>{title}</Text>
    </Pressable>
  )
}
