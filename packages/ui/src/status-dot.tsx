import { cn } from "./lib/utils"

// The status atom. Five meanings, three sizes, and never colour alone: a dot
// without an adjacent label is unreadable to anyone who cannot separate amber
// from green, so the label is a required prop rather than a convention.
export type StatusMeaning = "online" | "waiting" | "offline" | "handoff" | "idle"
export type StatusDotSize = "inline" | "default" | "header"

const fill: Record<StatusMeaning, string> = {
  online: "bg-success",
  waiting: "bg-warning",
  offline: "bg-destructive",
  handoff: "bg-info",
  idle: "bg-faint",
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
  className,
}: {
  meaning: StatusMeaning
  label: string
  size?: StatusDotSize
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden className={cn("shrink-0 rounded-full", diameter[size], fill[meaning])} />
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
    </span>
  )
}
