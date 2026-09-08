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
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (sessionId: string) => void
  className?: string
}) {
  const groups = groupSessions(snapshot)

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground"
      >
        {open ? "Hide sessions" : "Sessions"}
        <span className="font-mono text-[10.5px] text-faint">
          {groups.reduce((total, group) => total + group.sessions.length, 0)}
        </span>
      </button>

      <FloatingSurface open={open} onClose={() => onOpenChange(false)} label="Sessions" className="w-72">
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
      </FloatingSurface>
    </div>
  )
}
