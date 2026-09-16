import { ArchiveIcon, ChevronRightIcon, EllipsisIcon, GitForkIcon, MonitorIcon, PauseIcon } from "lucide-react"
import { useState } from "react"

import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { StatusDot } from "./status-dot"
import { groupSessions, type SessionGroupId } from "./session-groups"
import { cn } from "./lib/utils"

// v2 takes the sessions list out of the permanent sidebar and puts it behind a
// button in the top bar. When open it is a column beside the thread at the
// design system's sidebar width (the v2 template draws 268px; the token the
// design system publishes is what the shell reads), grouped by what each
// session wants from you, each group collapsible with
// its count, and every row carrying the session's own actions in a menu:
// stop the agent, fork from a checkpoint, move to another machine, archive.
// The design also draws "Delete the worktree"; the protocol has no such RPC,
// so the menu does not offer it. The count that matters stays on the button,
// because a session waiting on a person blocks work and a closed drawer hides
// it.

export type SessionRowAction = "stop" | "fork" | "move" | "archive"

export function SessionsDrawerTrigger({
  snapshot,
  open,
  onOpenChange,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}) {
  const groups = groupSessions(snapshot)
  const needsYou = groups.find((group) => group.id === "needs-you")?.sessions.length ?? 0
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="sessions-drawer"
      onClick={() => onOpenChange(!open)}
      className={cn(
        "flex items-center gap-2 rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground",
        open && "bg-accent text-foreground",
        className,
      )}
    >
      {open ? "Hide sessions" : "Sessions"}
      <span className="font-machine text-[10.5px] text-faint">
        {groups.reduce((total, group) => total + group.sessions.length, 0)}
      </span>
      {needsYou > 0 ? (
        <span className="rounded-full bg-warn-background px-2 py-[2px] text-[10.5px] text-warn-foreground">
          {needsYou} needs you
        </span>
      ) : null}
    </button>
  )
}

export function SessionsDrawerColumn({
  snapshot,
  open,
  onActivate,
  onAction,
  onNewSession,
  onOpenProviderSettings,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onActivate: (sessionId: string) => void
  onAction?: ((action: SessionRowAction, sessionId: string) => void) | undefined
  onNewSession?: (() => void) | undefined
  onOpenProviderSettings?: (() => void) | undefined
  className?: string
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionGroupId>>(new Set())
  if (!open) return null
  const groups = groupSessions(snapshot)
  const machine = snapshot.machine.name
  const toggle = (id: SessionGroupId) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <aside
      id="sessions-drawer"
      aria-label="Sessions"
      className={cn("flex w-[var(--shell-sidebar)] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar", className)}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {groups.length === 0 ? (
          <p className="m-0 px-2 py-3 text-[11.5px] text-faint">
            No sessions on this machine yet.
          </p>
        ) : null}
        {groups.map((group) => {
          const shut = collapsed.has(group.id)
          return (
            <section key={group.id} aria-label={group.label} className="flex flex-col gap-0.5 pb-2">
              <button
                type="button"
                aria-expanded={!shut}
                onClick={() => toggle(group.id)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
              >
                <ChevronRightIcon className={cn("size-3 text-faint transition-transform", !shut && "rotate-90")} />
                <span className="text-[10.5px] tracking-[0.13em] text-faint">{group.label}</span>
                <span className="flex-1" />
                <span className="rounded-full bg-muted px-1.5 font-machine text-[10.5px] text-muted-foreground">{group.sessions.length}</span>
              </button>
              {shut ? null : group.sessions.map((entry) => {
                const current = entry.id === snapshot.activeSessionId
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      // The tint is the third signal, after the Current mark
                      // and aria-current. Colour never carries this on its own.
                      "group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60",
                      current && "bg-accent",
                      entry.meaning === "idle" && "opacity-70",
                    )}
                  >
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => onActivate(entry.id)}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                    >
                      <span className="line-clamp-2 text-[12px] leading-[1.38] text-strong">{entry.title}</span>
                      <span className="flex w-full items-center gap-2">
                        <StatusDot meaning={entry.meaning} label={`${machine} · ${entry.note}`} size="inline" />
                        {current ? (
                          <span className="ml-auto rounded-full border border-border px-1.5 py-[1px] text-[10.5px] text-muted-foreground">
                            Current
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {onAction ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Actions for ${entry.title}`}
                            className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-muted data-[state=open]:opacity-100"
                          >
                            <EllipsisIcon className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[214px]">
                          {entry.running ? (
                            <DropdownMenuItem onSelect={() => onAction("stop", entry.id)}><PauseIcon />Stop the agent</DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("fork", entry.id)}><GitForkIcon />Fork from a checkpoint</DropdownMenuItem>
                          <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("move", entry.id)}><MonitorIcon />Move to another machine</DropdownMenuItem>
                          <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("archive", entry.id)}><ArchiveIcon />Archive session</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
      {onNewSession || onOpenProviderSettings ? (
        // Outside the scroller on purpose: these stay reachable no matter how
        // many sessions are open.
        <div className="flex shrink-0 gap-1 border-t border-border p-1">
          {onNewSession ? (
            <button type="button" onClick={onNewSession} className="flex-1 rounded-md px-2 py-1.5 text-left text-[12px] text-strong hover:bg-accent">
              New session
            </button>
          ) : null}
          {onOpenProviderSettings ? (
            <button type="button" onClick={onOpenProviderSettings} className="rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent">
              Providers
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}

// The trigger and the column together, for surfaces that lay them out as one.
// The shell places the trigger in the top bar and the column beside the thread.
export function SessionsDrawer({
  snapshot,
  open,
  onOpenChange,
  onActivate,
  onAction,
  onNewSession,
  onOpenProviderSettings,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (sessionId: string) => void
  onAction?: ((action: SessionRowAction, sessionId: string) => void) | undefined
  onNewSession?: (() => void) | undefined
  onOpenProviderSettings?: (() => void) | undefined
  className?: string
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <SessionsDrawerTrigger snapshot={snapshot} open={open} onOpenChange={onOpenChange} className="self-start" />
      <SessionsDrawerColumn
        snapshot={snapshot}
        open={open}
        onActivate={onActivate}
        onAction={onAction}
        onNewSession={onNewSession}
        onOpenProviderSettings={onOpenProviderSettings}
        className="mt-2 max-h-[70vh]"
      />
    </div>
  )
}
