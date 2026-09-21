import { toolFileEntries, type ToolFileEntry } from "@getdomovoi/protocol"
import { ChevronRightIcon } from "lucide-react"
import { memo, useState } from "react"

import { StatusDot, type StatusMeaning } from "./status-dot"
import { cn } from "./lib/utils"

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
    parts.push(`running ${current.argument ?? current.name}`)
    return parts.join(" · ")
  }
  const failures = items.filter((item) => item.failed).length
  if (failures > 0) parts.push(plural(failures, "failure"))
  return parts.join(" · ")
}

// The label answers the turn, not the tool count. While the turn runs it says
// so; a running row that counted its calls would read as a turn that had
// already stopped. The count is what the row becomes once it is done.
function activityLabel(items: readonly ToolActivity[], running: boolean): string {
  if (running) return "Working"
  if (items.length === 0) return "No tool calls"
  const failures = items.filter((item) => item.failed).length
  const counted = `${items.length} ${items.length === 1 ? "tool call" : "tool calls"}`
  return failures > 0 ? `${counted}, ${failures} failed` : counted
}

// A streaming reply re-renders the thread once per token. Every row above the
// growing one has the tool calls it already had, and groupThreadActivity hands
// back the same objects for them, so this draws only when its own turn changes.
export const TurnActivity = memo(function TurnActivity({
  items,
  running,
  meta,
  className,
}: {
  items: readonly ToolActivity[]
  running: boolean
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
        className="flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1 text-muted-foreground disabled:cursor-default disabled:opacity-100"
      >
        {items.length > 0 ? (
          <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        ) : null}
        <span className="text-[11.5px]">{activityLabel(items, running)}</span>
        {metaLine ? <span className="font-mono text-[10.5px] text-faint">{metaLine}</span> : null}
        {running ? (
          // The only moving thing on the screen, and it says the turn is alive
          // rather than estimating a duration nobody can know.
          <span aria-hidden className="relative block h-[3px] w-[34px] overflow-hidden rounded-[3px] bg-muted">
            <span className="sweep-bar absolute inset-0 block w-[30%] rounded-[3px] bg-primary" />
          </span>
        ) : null}
      </button>

      {open ? (
        <ol className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0">
          {items.map((item) => (
            <li key={item.id} className="border-b border-border last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <StatusDot
                  meaning={(item.failed ? "offline" : "online") as StatusMeaning}
                  label={item.name}
                  size="inline"
                />
                {item.argument ? (
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">{item.argument}</span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-faint">{item.outcome}</span>
                {item.log ? (
                  <button
                    type="button"
                    aria-expanded={openLog === item.id}
                    onClick={() => setOpenLog((current) => current === item.id ? undefined : item.id)}
                    className="text-[11px] text-primary"
                  >
                    {openLog === item.id ? "Hide output" : "Output"}
                  </button>
                ) : null}
              </div>
              {openLog === item.id && item.log ? (
                <pre className="m-0 max-h-40 overflow-auto border-t border-border bg-code px-3 py-2 font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground">
                  {item.log}
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
})
