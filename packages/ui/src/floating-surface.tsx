import { useEffect, useRef, type ReactNode } from "react"

import { cn } from "./lib/utils"

// The popover the v2 set leans on: session drawer, model search, usage readout,
// session actions. It is a surface, not a dialog, so it does not trap focus or
// dim the page. It closes on Escape and on a click outside, and it returns focus
// to whatever opened it, because a keyboard user who opens one from a chip has
// nowhere to go otherwise.
export function FloatingSurface({
  open,
  onClose,
  label,
  align = "start",
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  label: string
  align?: "start" | "end"
  children: ReactNode
  className?: string
}) {
  const surface = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    const onPointer = (event: MouseEvent) => {
      if (!surface.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener("keydown", onKey)
    // Pointer close runs on the next frame so the click that opened this
    // surface does not immediately close it.
    const timer = setTimeout(() => document.addEventListener("mousedown", onPointer), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onPointer)
      const previous = opener.current
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      ref={surface}
      role="group"
      aria-label={label}
      className={cn(
        "absolute top-[calc(100%+6px)] z-50 min-w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  )
}
