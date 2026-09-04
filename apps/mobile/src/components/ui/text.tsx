import { Text as RNText, type TextProps } from "react-native"

import { cn } from "../../lib/cn"

type Variant = "body" | "title" | "heading" | "label" | "meta" | "machine"

// The desktop shell reaches for a font size and colour at every call site. Here
// the variants are named, so a screen cannot quietly invent a tenth text style.
const variants: Record<Variant, string> = {
  heading: "text-[30px] font-semibold tracking-tight text-foreground",
  title: "text-[15px] font-semibold text-foreground",
  body: "text-[13px] text-foreground",
  label: "text-[11px] font-medium uppercase tracking-[0.08em] text-faint",
  meta: "text-[12px] text-muted-foreground",
  machine: "font-machine text-[11px] text-muted-foreground",
}

export function Text({
  variant = "body",
  className,
  ...props
}: TextProps & { variant?: Variant }) {
  return <RNText className={cn(variants[variant], className)} {...props} />
}
