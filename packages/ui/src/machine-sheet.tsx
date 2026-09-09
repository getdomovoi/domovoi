import { useEffect, useRef, type ReactNode, type RefObject } from "react"

import { cn } from "./lib/utils"

// v2 moves the machine surfaces out of a permanent inspector and into one sheet
// over the thread. Floating, it dims the thread and closes on Escape or the
// scrim, because it is borrowed space. Pinned, it becomes a panel beside the
// thread: no scrim, and Escape leaves it alone, because a panel someone pinned
// is not something to dismiss by reflex.
export type SheetTab = {
  id: string
  label: string
  count?: string
  describe: string
}

export function MachineSheet({
  open,
  pinned,
  tabs,
  activeTab,
  onSelectTab,
  onClose,
  onTogglePin,
  pinButtonRef,
  children,
}: {
  open: boolean
  pinned: boolean
  // Content that carries its own tab bar passes none, and the sheet renders
  // only the pin control above it.
  tabs?: readonly SheetTab[]
  activeTab?: string
  onSelectTab?: (id: string) => void
  onClose: () => void
  onTogglePin: () => void
  // The shell swaps this sheet for a pinned panel, so it needs a handle on the
  // control that starts the swap to place focus afterwards.
  pinButtonRef?: RefObject<HTMLButtonElement | null> | undefined
  children: ReactNode
}) {
  const opener = useRef<Element | null>(null)
  // Only closing returns focus. A callback identity change is not a close, and
  // treating it as one steals focus from an input inside the open sheet.
  const close = useRef(onClose)
  close.current = onClose

  // Focus follows the open state alone. Keyed on pinned as well, pinning an
  // open sheet tore the effect down and threw focus back to whatever opened it.
  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement
    return () => {
      const previous = opener.current
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [open])

  // Escape closes a floating sheet only. A pinned one is part of the layout.
  useEffect(() => {
    if (!open || pinned) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, pinned])

  if (!open) return null

  return (
    <div className={cn("absolute inset-y-0 right-0 flex", pinned ? "relative" : "left-0 z-40")}>
      {pinned ? null : (
        <button
          type="button"
          aria-label="Close the sheet"
          onClick={onClose}
          className="flex-1 cursor-default bg-overlay"
        />
      )}
      <section
        aria-label="Machine surfaces"
        className={cn(
          "flex w-[560px] flex-col border-l border-border bg-background",
          pinned ? "" : "shadow-xl",
        )}
      >
        <div className="flex items-center gap-1 border-b border-border p-2">
          {(tabs ?? []).map((tab) => (
            <button
              type="button"
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTab}
              title={tab.describe}
              onClick={() => onSelectTab?.(tab.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px]",
                tab.id === activeTab ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              {tab.label}
              {tab.count ? <span className="font-mono text-[10.5px] text-faint">{tab.count}</span> : null}
            </button>
          ))}
          <button
            ref={pinButtonRef}
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            className="ml-auto rounded-md px-2 py-1 text-[11.5px] text-muted-foreground"
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </section>
    </div>
  )
}
