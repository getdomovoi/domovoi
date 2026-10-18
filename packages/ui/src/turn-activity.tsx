import { toolFileEntries, type ToolFileEntry } from "@getdomovoi/protocol"
import { ChevronRightIcon } from "lucide-react"
import { memo, useState } from "react"

import { StatusDot, type StepMeaning } from "./status-dot"
import { cn } from "./lib/utils"
import type { ActivityTiming } from "./turn-clock"

// While a turn runs, v2 shows one line of prose and one collapsed row. Nothing
// else moves: a thread that reflows on every tool call cannot be read, and the
// detail is one click away rather than gone.
export type ToolActivity = {
  id: string
  name: string
  argument?: string
  outcome?: string
  failed?: boolean
  files?: readonly (string | ToolFileEntry)[]
  log?: string
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

// A running command can be a quoted script thousands of characters long (walk
// finding F7). The row names it by its first line, cut to a bound, and says it
// was cut; the step keeps the whole text.
const commandSummaryLength = 72

export function commandSummary(command: string): string {
  const lines = command.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
  const first = (lines[0] ?? "").replace(/\s+/gu, " ")
  // Cut by code point, so a character outside the BMP is kept or dropped
  // whole rather than leaving half a surrogate pair to draw as a box.
  const points = Array.from(first)
  if (points.length > commandSummaryLength) return `${points.slice(0, commandSummaryLength - 1).join("").trimEnd()}…`
  return lines.length > 1 ? `${first}…` : first
}

function commandShortened(command: string | undefined): command is string {
  return command !== undefined && commandSummary(command) !== command
}

// The line beside the label: how much of the worktree the turn has moved, and
// what it is doing right now. A count nobody can verify is worse than no count,
// so files are the distinct paths the calls reported and nothing is inferred
// from a title.
export function activityMeta(items: readonly ToolActivity[], running: boolean): string | undefined {
  if (items.length === 0) return undefined
  const parts = [plural(items.length, "tool")]
  const files = new Set(items.flatMap((item) => toolFileEntries(item.files).map((file) => file.path)))
  if (files.size > 0) parts.push(plural(files.size, "file"))
  const current = running ? items.find((item) => item.outcome === "running") : undefined
  if (current) {
    const summary = current.argument === undefined ? "" : commandSummary(current.argument)
    parts.push(`running ${summary || current.name}`)
    return parts.join(" · ")
  }
  const failures = items.filter((item) => item.failed).length
  if (failures > 0) parts.push(plural(failures, "failure"))
  return parts.join(" · ")
}

// The label answers the turn, not the tool count. While the turn runs it says
// so; a running row that counted its calls would read as a turn that had
// already stopped. Once it is done it says how long the turn worked, or that
// it stopped (Desktop V2: Working, Worked for 4m 18s, show the steps,
// Stopped). Without the turn's timing the count is what the row becomes.
function activityLabel(items: readonly ToolActivity[], running: boolean, timing: ActivityTiming | undefined, open: boolean): string {
  if (running) return "Working"
  if (timing?.kind === "worked") return open ? `Worked for ${timing.duration}` : `Worked for ${timing.duration}, show the steps`
  if (timing?.kind === "stopped") return "Stopped"
  if (items.length === 0) return "No tool calls"
  const failures = items.filter((item) => item.failed).length
  const counted = `${items.length} ${items.length === 1 ? "tool call" : "tool calls"}`
  return failures > 0 ? `${counted}, ${failures} failed` : counted
}

// Desktop V2 colours a step's dot by its outcome: ok in success, a failure in
// destructive, a call blocked at a gate in warning, one running in primary,
// and one with no result in muted. A call still marked running in a row whose
// turn is no longer running has no result anyone saw, and its row says so in
// the design's words, no result.
function stepMeaning(item: ToolActivity, running: boolean): StepMeaning {
  if (item.failed || item.outcome === "failed") return "offline"
  switch (item.outcome) {
    case "completed": return "online"
    case "declined": return "waiting"
    case "running": return running ? "working" : "idle"
    default: return "idle"
  }
}

// A streaming reply re-renders the thread once per token. Every row above the
// growing one has the tool calls it already had, and groupThreadActivity hands
// back the same objects for them, so this draws only when its own turn changes.
export const TurnActivity = memo(function TurnActivity({
  items,
  running,
  timing,
  meta,
  className,
}: {
  items: readonly ToolActivity[]
  running: boolean
  // The turn's time once the row is done (turn-clock.ts activityTiming).
  timing?: ActivityTiming | undefined
  meta?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [openLog, setOpenLog] = useState<string>()
  const metaLine = meta ?? activityMeta(items, running)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <button
        type="button"
        aria-expanded={open}
        // Until the first tool call there is nothing to expand, and a chip that
        // opens an empty list reads as a broken control.
        disabled={items.length === 0}
        onClick={() => setOpen((current) => !current)}
        // One line at any width: the row may shrink to its column and cut its
        // meta, never wrap into a taller pill over the thread.
        className="flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full border border-border px-3 py-1 text-left text-muted-foreground disabled:cursor-default disabled:opacity-100"
      >
        {items.length > 0 ? (
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        ) : null}
        <span className="shrink-0 text-[11.5px] whitespace-nowrap">{activityLabel(items, running, timing, open)}</span>
        {metaLine ? <span className="min-w-0 truncate font-mono text-[10.5px] text-faint">{metaLine}</span> : null}
        {running ? (
          // The only moving thing on the screen, and it says the turn is alive
          // rather than estimating a duration nobody can know.
          <span aria-hidden className="relative block h-[3px] w-[34px] shrink-0 overflow-hidden rounded-[3px] bg-muted">
            <span className="sweep-bar absolute inset-0 block w-[30%] rounded-[3px] bg-primary" />
          </span>
        ) : null}
      </button>

      {open ? (
        <ol className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0">
          {items.map((item) => {
            const logOpen = openLog === item.id
            // A command cut to fit its row opens to its whole text, so the
            // step keeps what the row had no room for.
            const fullCommand = commandShortened(item.argument) ? item.argument : undefined
            const opens = Boolean(item.log) || fullCommand !== undefined
            const step = (
              <>
                <StatusDot meaning={stepMeaning(item, running)} label={item.name} size="inline" />
                {/* A cut command shows its summary, which also bounds the
                    step button's accessible name; one short enough to
                    keep whole can still be cut by a narrow column, so it
                    carries its text as a title. */}
                {item.argument ? (
                  <span
                    className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground"
                    {...(fullCommand === undefined ? { title: item.argument } : {})}
                  >
                    {fullCommand === undefined ? item.argument : commandSummary(item.argument)}
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-faint">{item.outcome === "running" && !running ? "no result" : item.outcome}</span>
              </>
            )
            return (
            <li key={item.id} className="border-b border-border last:border-b-0">
              {/* Desktop V2 opens a step's log from its whole row, so a step
                  with a log, or with a command cut to fit, is one button; a
                  step with neither is not a control. */}
              {opens ? (
                <button
                  type="button"
                  aria-expanded={logOpen}
                  onClick={() => setOpenLog((current) => current === item.id ? undefined : item.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
                >
                  {step}
                  <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform", logOpen && "rotate-90")} />
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2">{step}</div>
              )}
              {logOpen && fullCommand !== undefined ? (
                <pre className="m-0 max-h-40 overflow-auto border-t border-border bg-code px-3 py-2 font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground">
                  {fullCommand}
                </pre>
              ) : null}
              {logOpen && item.log ? (
                <pre className="m-0 max-h-40 overflow-auto border-t border-border bg-code px-3 py-2 font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground">
                  {item.log}
                </pre>
              ) : null}
            </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}, (before, next) => {
  // The thread builds the timing afresh each render, so it is compared by what
  // it says; every other prop by identity, as memo would.
  const keys = new Set([...Object.keys(before), ...Object.keys(next)]) as Set<keyof typeof before>
  for (const key of keys) {
    if (key === "timing") {
      if (!sameTiming(before.timing, next.timing)) return false
    } else if (!Object.is(before[key], next[key])) {
      return false
    }
  }
  return true
})

function sameTiming(before: ActivityTiming | undefined, next: ActivityTiming | undefined): boolean {
  if (before === undefined || next === undefined) return before === next
  if (before.kind !== next.kind) return false
  return before.kind !== "worked" || next.kind !== "worked" || before.duration === next.duration
}
