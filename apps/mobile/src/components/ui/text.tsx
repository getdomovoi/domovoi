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
// Every size here is a token generated from --text-phone-* in
// packages/ui/src/styles.css, beside the desktop ramp rather than derived from
// it. The phone's steps are smaller because a phone has less width — that is
// layout pressure, not legibility. A CSS pixel subtends a fixed angle by
// definition, so a size is no more readable on a phone than on a desk, and the
// phone's floor is therefore higher than the desktop's rather than lower.
// `machine` at 10px is as far down as this scale goes, and nothing may sit
// below it. That is the design's floor, not a platform threshold: Text forwards
// its props, so allowFontScaling stays at React Native's default of true at
// every size, and the floor is the smallest size the design calls legible.
const variants: Record<Variant, string> = {
  heading: "font-sans-semibold text-heading tracking-[-0.02em] text-foreground",
  nav: "font-sans-medium text-nav text-foreground",
  section: "font-sans-medium text-section text-foreground",
  title: "font-sans text-title text-foreground",
  body: "font-sans text-body text-foreground",
  meta: "font-sans text-meta text-muted-foreground",
  note: "font-sans text-note text-muted-foreground",
  label: "font-sans text-label uppercase tracking-[0.08em] text-faint",
  machine: "font-mono text-machine text-muted-foreground",
}

export function Text({
  variant = "body",
  className,
  ...props
}: TextProps & { variant?: Variant }) {
  return <RNText className={cn(variants[variant], className)} {...props} />
}
