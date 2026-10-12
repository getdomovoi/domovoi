import { cn } from "./lib/utils"

// The status atom. Five meanings (and one for a step in flight), three sizes, and never colour alone: a dot
// without an adjacent label is unreadable to anyone who cannot separate amber
// from green, so the label is a required prop rather than a convention.
export type StatusMeaning = "online" | "waiting" | "offline" | "handoff" | "idle"
// A step still in flight, which Desktop V2 draws in primary in a turn's step
// list. It is kept out of StatusMeaning: sessions, machines and terminals
// have no step in flight, and the tables that map their states stay
// exhaustive over the five above.
export type StepMeaning = StatusMeaning | "working"
export type StatusDotSize = "inline" | "default" | "header"

const fill: Record<StepMeaning, string> = {
  online: "bg-success",
  waiting: "bg-warning",
  offline: "bg-destructive",
  handoff: "bg-info",
  idle: "bg-faint",
  working: "bg-primary",
}

const diameter: Record<StatusDotSize, string> = {
  inline: "size-[5px]",
  default: "size-[7px]",
  header: "size-[9px]",
}

export function StatusDot({
  meaning,
  label,
  size = "default",
  labelHidden = false,
  className,
}: {
  meaning: StepMeaning
  label: string
  size?: StatusDotSize
  // A row that already carries its own prose beside the dot has no room for a
  // second visible label. Hiding it is not dropping it: the label stays
  // required and stays in the accessibility tree, because the rule above is
  // about who can read the meaning, not about who can see it.
  labelHidden?: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center", labelHidden ? "" : "gap-2", className)}>
      {/* The forced-colors override in styles.css keys on this marker, so the
          atom keeps it; the lint rule exempts this file, which is the one
          place the marker belongs. */}
      <span aria-hidden data-status-dot="" className={cn("shrink-0 rounded-full", diameter[size], fill[meaning])} />
      <span className={labelHidden ? "sr-only" : "text-[11.5px] text-muted-foreground"}>{label}</span>
    </span>
  )
}
