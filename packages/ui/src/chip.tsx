import type { ReactNode } from "react"

import { cn } from "./lib/utils"

// One family at three paddings, because the v2 set uses the same shape at three
// weights and drifted into 71 ad-hoc values before they were snapped to a named
// set. Badge states a fact, chip carries a value, control is pressable.
export type ChipSize = "badge" | "chip" | "control"
export type ChipTone = "neutral" | "warning" | "danger" | "info" | "ok" | "primary"

const padding: Record<ChipSize, string> = {
  badge: "px-2 py-[2px] text-[10.5px]",
  chip: "px-[10px] py-[5px] text-[11.5px]",
  control: "px-3 py-[6px] text-[12.5px]",
}

const tone: Record<ChipTone, string> = {
  neutral: "border-border bg-accent text-muted-foreground",
  warning: "border-warn-border bg-warn-background text-warn-foreground",
  danger: "border-danger-border bg-danger-background text-danger-foreground",
  info: "border-info-border bg-info-background text-info-foreground",
  ok: "border-ok-border bg-ok-background text-ok-foreground",
  primary: "border-primary bg-primary text-primary-foreground",
}

export function Chip({
  size = "chip",
  tone: chipTone = "neutral",
  mono,
  onClick,
  children,
  className,
}: {
  size?: ChipSize
  tone?: ChipTone
  mono?: boolean
  onClick?: () => void
  children: ReactNode
  className?: string
}) {
  const shared = cn(
    "inline-flex items-center gap-1.5 rounded-full border whitespace-nowrap",
    padding[size],
    tone[chipTone],
    // Mono is for machine output: shas, paths, counts a daemon produced.
    mono && "font-mono",
    className,
  )
  if (!onClick) return <span className={shared}>{children}</span>
  return (
    <button type="button" onClick={onClick} className={shared}>
      {children}
    </button>
  )
}
