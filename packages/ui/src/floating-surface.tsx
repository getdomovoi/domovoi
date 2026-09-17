import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"

import { cn } from "./lib/utils"

// The popover the v2 set leans on: session drawer, model search, usage readout,
// session actions. It is a surface, not a dialog, so it does not trap focus or
// dim the page. It closes on Escape and on a click outside, and it returns focus
// to whatever opened it, because a keyboard user who opens one from a chip has
// nowhere to go otherwise.
//
// It renders in a portal rather than beside its trigger. Positioned in place it
// was cut off by an ancestor when it opened upward from the composer, losing
// its first rows: the mode list's Plan and Ask could not be reached on a real
// screen while every test passed, because jsdom has no layout and cannot see
// clipping. A portal takes the surface out of every ancestor's overflow, so the
// only thing that can bound it is the window.

export type FloatingPlacement = "below" | "above"

type Position = { left: number; top: number; maxHeight: number } | undefined

const gap = 8

function positionFor(anchor: HTMLElement, surface: HTMLElement, placement: FloatingPlacement, align: "start" | "end"): Position {
  const rect = anchor.getBoundingClientRect()
  const width = surface.offsetWidth
  const height = surface.offsetHeight
  // Flip rather than run off the window: a surface that opens past the edge
  // puts its rows where no pointer can reach them.
  const roomAbove = rect.top - gap
  const roomBelow = window.innerHeight - rect.bottom - gap
  const above = placement === "above" ? roomAbove >= Math.min(height, 160) || roomAbove >= roomBelow : roomBelow < Math.min(height, 160) && roomAbove > roomBelow
  const top = above ? Math.max(gap, rect.top - gap - height) : rect.bottom + gap
  const rawLeft = align === "end" ? rect.right - width : rect.left
  const left = Math.max(gap, Math.min(rawLeft, window.innerWidth - width - gap))
  return { left, top, maxHeight: Math.max(120, (above ? roomAbove : roomBelow)) }
}

export function FloatingSurface({
  open,
  onClose,
  label,
  align = "start",
  placement = "below",
  trigger,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  label: string
  align?: "start" | "end"
  placement?: FloatingPlacement
  trigger?: RefObject<HTMLElement | null> | undefined
  children: ReactNode
  className?: string
}) {
  const surface = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const [position, setPosition] = useState<Position>(undefined)
  // Focus goes back to the opener when the surface closes, and only then. If
  // the effect depended on onClose, an unrelated render would tear it down and
  // pull focus out of whatever the person was typing in.
  const close = useRef(onClose)
  close.current = onClose

  // Measured after paint and before the browser shows it, so it never appears
  // at the wrong place first.
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return }
    const anchor = trigger?.current
    const element = surface.current
    if (!anchor || !element) return
    const place = () => setPosition(positionFor(anchor, element, placement, align))
    place()
    window.addEventListener("resize", place)
    // Capture: a surface anchored to a chip inside a scrolling pane has to
    // follow it, and scroll does not bubble.
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, trigger, placement, align])

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
      const target = event.target as Node
      if (surface.current?.contains(target)) return
      // The trigger owns the toggle. Closing here would let its own click see a
      // closed surface and open it straight back up.
      if (trigger?.current?.contains(target)) return
      close.current()
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
  }, [open, trigger])

  if (!open) return null
  const surfaceNode = (
    <div
      ref={surface}
      role="group"
      aria-label={label}
      style={{
        position: "fixed",
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position?.maxHeight,
        // Hidden only for the first frame, while it waits to be measured. A
        // surface given no trigger has nothing to measure against, so it shows
        // where it lands rather than never showing at all.
        visibility: position || !trigger ? "visible" : "hidden",
      }}
      className={cn(
        "z-50 min-w-56 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  )
  // Without a document there is nothing to portal into, which is the case in a
  // non-browser render; the surface still renders so its contents are testable.
  return typeof document === "undefined" ? surfaceNode : createPortal(surfaceNode, document.body)
}
