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
  // Focus goes back to the opener when the surface closes, and only then. If
  // the effect depended on onClose, an unrelated render would tear it down and
  // pull focus out of whatever the person was typing in.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        close.current()
      }
    }
    const onPointer = (event: MouseEvent) => {
      if (!surface.current?.contains(event.target as Node)) close.current()
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
  }, [open])

  if (!open) return null
  return (
    <div
      ref={surface}
      role="group"
      aria-label={label}
      className={cn(
        // A surface never grows past the window. Without this a long list runs
        // off the bottom of the screen and whatever sits under it, an action
        // or the last row, cannot be reached at all.
        "absolute top-[calc(100%+6px)] z-50 max-h-[70vh] min-w-56 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  )
}
