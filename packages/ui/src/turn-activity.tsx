import { ChevronRightIcon } from "lucide-react"
import { useState } from "react"

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
  log?: string
}

function activityLabel(items: readonly ToolActivity[], running: boolean): string {
  if (items.length === 0) return running ? "Working" : "No tool calls"
  const failures = items.filter((item) => item.failed).length
  const counted = `${items.length} ${items.length === 1 ? "tool call" : "tool calls"}`
  return failures > 0 ? `${counted}, ${failures} failed` : counted
}

export function TurnActivity({
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

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1 text-muted-foreground"
      >
        <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className="text-[11.5px]">{activityLabel(items, running)}</span>
        {meta ? <span className="font-mono text-[10.5px] text-faint">{meta}</span> : null}
        {running ? (
          // The only moving thing on the screen, and it says the turn is alive
          // rather than estimating a duration nobody can know.
          <span aria-hidden className="relative block h-[3px] w-8 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-primary" />
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
}
