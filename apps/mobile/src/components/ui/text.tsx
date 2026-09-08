import { Text as RNText, type TextProps } from "react-native"

import { cn } from "../../lib/cn"

type Variant =
  | "heading"
  | "nav"
  | "section"
  | "title"
  | "body"
  | "meta"
  | "note"
  | "label"
  | "machine"

// The desktop shell reaches for a font size and colour at every call site. Here
// the variants are named, so a screen cannot quietly invent a tenth text style.
// Each variant names its face outright: React Native registers one font per
// weight, so a weight utility on top of a family would ask for a face that was
// never loaded and fall back to the platform font.
//
// The sizes are the ones the handoff draws on a 390pt phone. A phone is read at
// arm's length rather than desk distance, so the scale is tighter than the
// desktop's and the steps between roles are deliberately small.
const variants: Record<Variant, string> = {
  heading: "font-sans-semibold text-[26px] tracking-[-0.02em] text-foreground",
  nav: "font-sans-medium text-[13.5px] text-foreground",
  section: "font-sans-medium text-[11.5px] text-foreground",
  title: "font-sans text-[13px] leading-[18px] text-foreground",
  body: "font-sans text-[12.5px] leading-[19px] text-foreground",
  meta: "font-sans text-[11.5px] leading-[18px] text-muted-foreground",
  note: "font-sans text-[10.5px] leading-[16px] text-muted-foreground",
  label: "font-sans text-[10.5px] uppercase tracking-[0.08em] text-faint",
  machine: "font-mono text-[10px] text-muted-foreground",
}

export function Text({
  variant = "body",
  className,
  ...props
}: TextProps & { variant?: Variant }) {
  return <RNText className={cn(variants[variant], className)} {...props} />
}
