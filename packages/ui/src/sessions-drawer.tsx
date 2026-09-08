import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { FloatingSurface } from "./floating-surface"
import { StatusDot } from "./status-dot"
import { groupSessions } from "./session-groups"
import { cn } from "./lib/utils"

// v2 takes the sessions list out of the permanent sidebar and puts it behind a
// button, grouped by what each session wants from you. The count on the button
// is what stays visible, because a session waiting on a person blocks work and
// a list of titles does not.
export function SessionsDrawer({
  snapshot,
  open,
  onOpenChange,
  onActivate,
  onNewSession,
  onOpenProviderSettings,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (sessionId: string) => void
  onNewSession?: (() => void) | undefined
  onOpenProviderSettings?: (() => void) | undefined
  className?: string
}) {
  const groups = groupSessions(snapshot)
  const needsYou = groups.find((group) => group.id === "needs-you")?.sessions.length ?? 0

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground"
      >
        {open ? "Hide sessions" : "Sessions"}
        <span className="font-machine text-[10.5px] text-faint">
          {groups.reduce((total, group) => total + group.sessions.length, 0)}
        </span>
        {needsYou > 0 ? (
          // The count that matters stays on the button, because a session
          // waiting on a person blocks work and a closed drawer hides it.
          <span className="rounded-full bg-warning-background px-2 py-[2px] text-[10.5px] text-warning-foreground">
            {needsYou} needs you
          </span>
        ) : null}
      </button>

      <FloatingSurface open={open} onClose={() => onOpenChange(false)} label="Sessions" className="flex w-[var(--shell-sidebar)] flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="m-0 px-2 py-3 text-[11.5px] text-faint">
            No sessions on this machine yet.
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label} className="mb-1 last:mb-0">
            <p className="m-0 px-2 py-1 text-[10.5px] tracking-[0.13em] text-faint">{group.label}</p>
            {group.sessions.map((entry) => (
              <button
                type="button"
                key={entry.id}
                onClick={() => {
                  onActivate(entry.id)
                  onOpenChange(false)
                }}
                className={cn(
                  "flex w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                  entry.id === snapshot.activeSessionId && "bg-accent",
                )}
              >
                <span className="line-clamp-2 text-[12px] text-strong">{entry.title}</span>
                <StatusDot meaning={entry.meaning} label={entry.note} size="inline" />
              </button>
            ))}
          </section>
        ))}
        </div>
        {onNewSession || onOpenProviderSettings ? (
          // Outside the scroller on purpose: these stay reachable no matter how
          // many sessions are open.
          <div className="mt-1 flex shrink-0 gap-1 border-t border-border pt-1">
            {onNewSession ? (
              <button
                type="button"
                onClick={() => { onNewSession(); onOpenChange(false) }}
                className="flex-1 rounded-md px-2 py-1.5 text-left text-[12px] text-strong hover:bg-accent"
              >
                New session
              </button>
            ) : null}
            {onOpenProviderSettings ? (
              <button
                type="button"
                onClick={() => { onOpenProviderSettings(); onOpenChange(false) }}
                className="rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent"
              >
                Providers
              </button>
            ) : null}
          </div>
        ) : null}
      </FloatingSurface>
    </div>
  )
}
