import { ArchiveIcon, ChevronRightIcon, EllipsisIcon, GitBranchIcon, GitForkIcon, MonitorIcon, PanelLeftIcon, PauseIcon, PlayIcon } from "lucide-react"
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"

import type { ClientKind, SessionSummary, WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { StatusDot } from "./status-dot"
import { groupSessions, type GroupedSession, type SessionGroupId } from "./session-groups"
import { cn } from "./lib/utils"
import { dockSideBySideMinimumWidth } from "./dock-auto-collapse"
import { titlebarTipClassName } from "./titlebar-tip"
import { offInHandheldTab, useHandheldTabMachine } from "./handheld-tab"

// v2 takes the sessions list out of the permanent sidebar and puts it behind a
// button in the top bar (in a tab narrower than 40rem it covers the thread
// instead; see useNarrowTab). When open it is a column beside the thread at the
// design system's sidebar width (the v2 template draws 268px; the token the
// design system publishes is what the shell reads), grouped by what each
// session wants from you, each group collapsible with
// its count, and every row carrying the session's own actions in a menu:
// stop or resume the agent, fork from a checkpoint, move to another machine,
// and archive. Direct worktree deletion has no protocol method, so the menu
// cannot safely offer it. An archived row (I69) has no worktree left: its menu
// says so and draws the one way forward, a new session from the kept branch,
// disabled and marked later. The count that matters stays on the button,
// because a session waiting on a person blocks work and a closed drawer hides
// it.

export type SessionRowAction = "stop" | "resume" | "fork" | "move" | "archive"

// The Web v2 frame draws the sessions column always open; Q384 A opens it by
// default on the web at wide widths. Wide means room for the column beside a
// thread and dock that still sit side by side. The desktop keeps it behind its
// button, as Desktop v2 draws it.
export const webSessionsColumnMinimumWidth = dockSideBySideMinimumWidth + 268

export function sessionsColumnOpensByDefault(clientKind: ClientKind, viewportWidth: number): boolean {
  return clientKind === "web" && viewportWidth >= webSessionsColumnMinimumWidth
}

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
  const total = groups.reduce((count, group) => count + group.sessions.filter((session) => !session.archived).length, 0)
  // The badge points at the drawer from outside it; with the drawer open the
  // NEEDS YOU group says the same thing, so v2 draws the badge only while
  // closed. The count stays in the label either way.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${open ? "Hide sessions" : "Sessions"} ${total}${needsYou > 0 ? `, ${needsYou} needs you` : ""}`}
            aria-expanded={open}
            aria-controls="sessions-drawer"
            onClick={() => onOpenChange(!open)}
            className={cn(
              "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              open && "bg-accent text-foreground",
              className,
            )}
          >
            <PanelLeftIcon className="size-4" />
            {needsYou > 0 && !open ? <span data-needs-you-badge="" className="absolute top-[3px] right-[3px] size-[7px] rounded-full bg-destructive ring-2 ring-background" /> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={7} showArrow={false} className={titlebarTipClassName}>
          {open ? "Hide sessions" : "Sessions"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// The drawer's clock: the time rounded down to a tick, read whenever the
// column renders and advanced every tick while it is open. Rounding keeps the
// value stable between ticks, as useSyncExternalStore requires.
const clockTickMs = 15_000
const readClock = () => Math.floor(Date.now() / clockTickMs) * clockTickMs
const noClock = () => () => {}
const tickingClock = (changed: () => void) => {
  const timer = setInterval(changed, clockTickMs)
  return () => clearInterval(timer)
}

function useDrawerClock(open: boolean): number {
  return useSyncExternalStore(open ? tickingClock : noClock, readClock, readClock)
}

// Below Tailwind's sm breakpoint (40rem) the open column covers the thread
// instead of pushing it: beside the 268px column a phone's thread kept about
// 120px. The query is the one the stylesheet's max-sm variant uses.
const narrowTabQuery = "(width < 40rem)"
const subscribeNarrowTab = (changed: () => void) => {
  const query = globalThis.matchMedia?.(narrowTabQuery)
  query?.addEventListener("change", changed)
  return () => query?.removeEventListener("change", changed)
}
const readNarrowTab = () => globalThis.matchMedia?.(narrowTabQuery).matches ?? false

// The shell reads it too: while the column covers the thread, the shell draws
// the lost banner above the row rather than in the covered thread.
export function useNarrowTab(): boolean {
  return useSyncExternalStore(subscribeNarrowTab, readNarrowTab, () => false)
}

// The input a narrow tab's open column refuses behind it before the cover is
// drawn: keys (a keydown refused also stops the click Enter or Space would
// make), text input, and every step of a tap or click. Listened for on the
// document in the capture phase, ahead of React's listeners on its root.
const refusedInput = ["keydown", "keypress", "keyup", "beforeinput", "pointerdown", "mousedown", "mouseup", "click", "touchstart", "touchend"] as const

// The app bar's button that opens the column, where focus goes when a
// covering column closes or takes focus out of what it covers.
const sessionsButton = () => document.querySelector<HTMLElement>("[aria-controls='sessions-drawer']")

// How long, in the design's units: running 12m, failed 1h ago, idle 2d. A
// reading ahead of this client's clock counts as now.
function elapsed(since: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(since)) / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

// A row's meta after the machine name. Running counts from the start of the
// turn in flight, which the daemon reads from its ledger for each reply
// (activeTurnStartedAt); without one it says running and no more. Failed and
// idle count from the session's last change. These are the daemon's
// timestamps aged on this client's clock.
function rowMeta(entry: GroupedSession, session: SessionSummary | undefined, now: number): string {
  if (!session) return entry.note
  if (entry.note === "running") {
    return session.activeTurnStartedAt ? `running ${elapsed(session.activeTurnStartedAt, now)}` : "running"
  }
  if (entry.note === "failed") return `failed ${elapsed(session.updatedAt, now)} ago`
  if (entry.note === "idle") return `idle ${elapsed(session.updatedAt, now)}`
  return entry.note
}

export function SessionsDrawerColumn({
  snapshot,
  open,
  onOpenChange,
  onActivate,
  onAction,
  machineAvailability,
  onOpenMachines,
  scope,
  credentialNote,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  // Lets the column close itself where it covers the thread (a narrow tab).
  onOpenChange?: ((open: boolean) => void) | undefined
  onActivate: (sessionId: string) => void
  // A browser tab over the tailnet reaches one machine and holds its
  // credential for the tab only; the column says both (Web v2, 2026-09-23).
  scope?: { machine: string; note: string } | undefined
  credentialNote?: { label: string; meta: string } | undefined
  onAction?: ((action: SessionRowAction, sessionId: string) => void) | undefined
  onNewSession?: (() => void) | undefined
  onOpenProviderSettings?: (() => void) | undefined
  machineAvailability?: string | undefined
  onOpenMachines?: (() => void) | undefined
  className?: string
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionGroupId>>(new Set())
  const archivedNoteId = useId()
  const now = useDrawerClock(open)
  // session.archive is not on phoneAndTabletRpcMethods (handheld-tab.ts).
  const handheldMachine = useHandheldTabMachine()
  const archiveLocked = handheldMachine !== undefined
    ? offInHandheldTab(["Archive session"], "archive a session", handheldMachine)
    : undefined
  // Covering the thread in a narrow tab, the column makes the rest of its row
  // inert: whatever it covers, an approval card's Allow once included, takes
  // no focus, Tab, key press or tap until it closes. It closes on Escape, on a
  // tap on the strip of thread it leaves uncovered, and once a session is
  // chosen, and focus goes back to the Sessions button.
  const overlay = useNarrowTab() && open && onOpenChange !== undefined
  const asideRef = useRef<HTMLElement | null>(null)
  const close = useCallback(() => {
    onOpenChange?.(false)
    sessionsButton()?.focus()
  }, [onOpenChange])
  // No dependency list: this runs in every commit the column renders in,
  // which is every commit of the shell that owns the row, so a surface the
  // shell swaps in beside the column is inert in the commit that adds it. A
  // layout effect runs inside the commit that draws the cover, before paint
  // and before any input event: a tab that narrows with focus on Allow once
  // never shows the cover over a control that can still take a key. Focus
  // that is behind the cover then moves to the Sessions button; a browser
  // would only drop it to the body at its next rendering step.
  useLayoutEffect(() => {
    const aside = asideRef.current
    const row = aside?.parentElement
    if (!overlay || !aside || !row) return
    // Row menus, the archive dialog and the command palette draw in portals
    // outside the row, so they stay usable over the column.
    const covered = [...row.children].filter((child) => child !== aside && !child.hasAttribute("data-sessions-backdrop"))
    for (const element of covered) element.setAttribute("inert", "")
    const focused = document.activeElement
    if (focused && covered.some((element) => element.contains(focused))) {
      const button = sessionsButton()
      if (button) button.focus()
      else if (focused instanceof HTMLElement) focused.blur()
    }
    return () => {
      for (const element of covered) element.removeAttribute("inert")
    }
  })
  // A browser applies a new viewport at once but reports the media change at
  // its next rendering step, and an input event can run in between: Chromium
  // let Space through to a focused Allow once there, before the commit above
  // could draw the cover. So while the column is open, input aimed behind it
  // is refused whenever the live query says narrow, whatever React has drawn
  // yet; focus behind it moves to the Sessions button. At 40rem and wider
  // nothing is refused.
  useLayoutEffect(() => {
    if (!open || onOpenChange === undefined) return
    const refuse = (event: Event) => {
      const aside = asideRef.current
      const row = aside?.parentElement
      const target = event.target
      if (!aside || !row || !(target instanceof Node) || !row.contains(target) || aside.contains(target)) return
      if (target instanceof Element && target.hasAttribute("data-sessions-backdrop")) return
      if (!readNarrowTab()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const focused = document.activeElement
      if (focused && row.contains(focused) && !aside.contains(focused)) sessionsButton()?.focus()
    }
    for (const type of refusedInput) document.addEventListener(type, refuse, { capture: true, passive: false })
    return () => {
      for (const type of refusedInput) document.removeEventListener(type, refuse, { capture: true })
    }
  }, [open, onOpenChange])
  useEffect(() => {
    if (!overlay) return
    const closeOnEscape = (event: KeyboardEvent) => {
      // A menu or dialog above the column takes its own Escape and marks it
      // handled; only an unhandled one closes the column.
      if (event.key === "Escape" && !event.defaultPrevented) close()
    }
    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  }, [overlay, close])
  if (!open) return null
  const groups = groupSessions(snapshot)
  const machine = snapshot.machine.name
  const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]))
  const toggle = (id: SessionGroupId) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <>
    {/* The uncovered strip of thread: a tap there closes the column. The
        keyboard has Escape, so the strip is not a focus stop. z-50 puts it
        above the thread's raised controls (z-10) and the unpinned dock sheet
        (z-40, machine-sheet.tsx). The column, drawn after it at the same
        level, stays on top; menus and dialogs, in portals at the end of the
        body, above both. The lost banner is drawn above the row meanwhile
        (workspace-shell.tsx, connection-status.tsx). */}
    {overlay ? <div aria-hidden data-sessions-backdrop="" className="absolute inset-0 z-50 bg-foreground/10" onClick={close} /> : null}
    <aside
      ref={asideRef}
      id="sessions-drawer"
      aria-label="Sessions"
      className={cn("flex w-[268px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar", overlay && "absolute inset-y-0 left-0 z-50 shadow-lg", className)}
    >
      {scope ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-[14px] py-[9px]">
          <span className="font-machine text-[11px] text-strong">{scope.machine}</span>
          <span className="flex-1" />
          <span className="text-[10.5px] text-faint">{scope.note}</span>
        </div>
      ) : null}
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
                      "group flex items-start gap-[9px] rounded-md px-[9px] py-2 hover:bg-accent/60",
                      current && "bg-accent",
                      entry.meaning === "idle" && "opacity-55",
                    )}
                  >
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => {
                        onActivate(entry.id)
                        // A covering column gets out of the way of the chosen thread.
                        if (overlay) close()
                      }}
                      className="flex min-w-0 flex-1 items-start gap-[9px] text-left"
                    >
                      {/* The title comes first in the button's name, so the dot
                          column follows it in the DOM and is drawn first. The
                          visible meta is the dot's label; the dot's own copy of
                          it is hidden so a screen reader hears it once. */}
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="line-clamp-2 text-[12px] leading-[1.38] text-strong">{entry.title}</span>
                        <span data-session-meta="" className="mt-[3px] font-machine text-[10.5px] text-faint">{`${machine} · ${rowMeta(entry, sessionsById.get(entry.id), now)}`}</span>
                      </span>
                      <span aria-hidden className={cn("order-first mt-[5px] flex", entry.meaning === "idle" && "opacity-80")}>
                        <StatusDot meaning={entry.meaning} label={entry.note} size="inline" labelHidden />
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
                          {entry.archived ? (
                            <>
                              <DropdownMenuItem disabled title="Not built yet" aria-describedby={`${archivedNoteId}-${entry.id}`} className="justify-between">
                                <span className="flex items-center gap-2"><GitBranchIcon />Start a new session from this branch</span>
                                <span className="font-machine text-[10.5px] text-faint">later</span>
                              </DropdownMenuItem>
                              <p id={`${archivedNoteId}-${entry.id}`} className="m-0 px-2 py-1.5 text-[11px] leading-[1.5] text-muted-foreground">
                                Archived, so there is no worktree to delete. It cannot be forked, unarchived or sent to.
                              </p>
                            </>
                          ) : (
                            <>
                              {entry.running ? (
                                <DropdownMenuItem onSelect={() => onAction("stop", entry.id)}><PauseIcon />Stop the agent</DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("resume", entry.id)}><PlayIcon />Resume session</DropdownMenuItem>
                              )}
                              <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("fork", entry.id)}><GitForkIcon />Fork from a checkpoint</DropdownMenuItem>
                              <DropdownMenuItem disabled={entry.archiving} onSelect={() => onAction("move", entry.id)}><MonitorIcon />Move to another machine</DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={entry.archiving || archiveLocked !== undefined}
                                aria-describedby={archiveLocked !== undefined ? `${archivedNoteId}-locked-${entry.id}` : undefined}
                                onSelect={() => { if (archiveLocked === undefined) onAction("archive", entry.id) }}
                              ><ArchiveIcon />Archive session</DropdownMenuItem>
                              {archiveLocked !== undefined ? (
                                <p id={`${archivedNoteId}-locked-${entry.id}`} className="m-0 px-2 py-1.5 text-[11px] leading-[1.5] text-muted-foreground">{archiveLocked}</p>
                              ) : null}
                            </>
                          )}
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
      {credentialNote ? (
        <div className="flex shrink-0 items-center gap-2 border-t px-[14px] py-[9px]">
          <span aria-hidden className="size-1.5 rounded-full bg-info" />
          <span className="text-[11px]">{credentialNote.label}</span>
          <span className="flex-1" />
          <span className="font-machine text-[10.5px] text-faint">{credentialNote.meta}</span>
        </div>
      ) : null}
      {machineAvailability ? (
        <div className="flex shrink-0 items-center justify-center px-[10px] pt-[9px] pb-[11px]">
          <button type="button" className="font-machine text-[10.5px] text-muted-foreground" disabled={!onOpenMachines} onClick={onOpenMachines}>
            {machineAvailability}
          </button>
        </div>
      ) : null}
    </aside>
    </>
  )
}
