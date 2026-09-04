import { Text as RNText, type TextProps } from "react-native"

import { cn } from "../../lib/cn"

type Variant = "body" | "title" | "heading" | "label" | "meta" | "machine"

// The desktop shell reaches for a font size and colour at every call site. Here
// the variants are named, so a screen cannot quietly invent a tenth text style.
// Each variant names its face outright: React Native registers one font per
// weight, so a weight utility on top of a family would ask for a face that was
// never loaded and fall back to the platform font.
const variants: Record<Variant, string> = {
  heading: "font-sans-semibold text-[30px] tracking-tight text-foreground",
  title: "font-sans-semibold text-[15px] text-foreground",
  body: "font-sans text-[13px] text-foreground",
  label: "font-sans-medium text-[11px] uppercase tracking-[0.08em] text-faint",
  meta: "font-sans text-[12px] text-muted-foreground",
  machine: "font-mono text-[11px] text-muted-foreground",
}

export function Text({
  variant = "body",
  className,
  ...props
}: TextProps & { variant?: Variant }) {
  return <RNText className={cn(variants[variant], className)} {...props} />
}
