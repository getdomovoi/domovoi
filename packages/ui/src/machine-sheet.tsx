import { useEffect, useRef, type ReactNode } from "react"

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
  children,
}: {
  open: boolean
  pinned: boolean
  tabs: readonly SheetTab[]
  activeTab: string
  onSelectTab: (id: string) => void
  onClose: () => void
  onTogglePin: () => void
  children: ReactNode
}) {
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement
    if (pinned) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      const previous = opener.current
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [open, pinned, onClose])

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
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTab}
              title={tab.describe}
              onClick={() => onSelectTab(tab.id)}
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
