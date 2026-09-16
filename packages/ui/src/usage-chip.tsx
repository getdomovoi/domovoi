import type { RpcParams, SessionHistoryPage, SessionTurn, SessionUsage, UsageWindow } from "@getdomovoi/protocol"
import { ChartLineIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { formatTokenCount, formatUsageCost, sessionUsageCostNote, sessionUsageReportedCost } from "./session-usage.js"

// The v2 composer carries one usage chip, "42.1k · $0.38", that opens four
// rows: this turn, this session, the context with its share of the window,
// and a fourth the design draws as the provider's own rate window. No daemon
// can observe a provider's limit, so the fourth row here is today's usage from
// Domovoi's own accounting and says so; the value is real and the claim is
// the one that can be checked. A row whose numbers the daemon does not have
// is left out rather than guessed.

export type UsageChipRow = {
  label: string
  value: string
  note?: string | undefined
  // Percent of a bounded quantity, drawn as a bar; only the context has one.
  share?: number | undefined
}

export function usageChipText(usage: SessionUsage): string {
  return `${formatTokenCount(usage.totalTokens)} · ${sessionUsageReportedCost(usage) ?? "cost unavailable"}`
}

function turnRow(turn: SessionTurn | undefined): UsageChipRow | undefined {
  if (!turn) return undefined
  const model = turn.reportedModels.at(-1) ?? turn.requestedModel
  const tools = turn.recordedToolCount === 1 ? "1 tool result" : `${turn.recordedToolCount} tool results`
  return {
    label: "This turn",
    value: `${turn.usage.inputTokens.toLocaleString("en-US")} in · ${turn.usage.outputTokens.toLocaleString("en-US")} out`,
    note: `${model} · ${tools}`,
  }
}

function sessionRow(usage: SessionUsage): UsageChipRow {
  const cost = sessionUsageReportedCost(usage)
  return {
    label: "This session",
    value: `${formatTokenCount(usage.totalTokens)} tokens · ${cost ?? "cost unavailable"}`,
    note: sessionUsageCostNote(usage),
  }
}

function contextRow(usage: SessionUsage): UsageChipRow | undefined {
  if (usage.contextTokens === undefined || usage.contextWindowTokens === undefined) return undefined
  return {
    label: "Context",
    value: `${formatTokenCount(usage.contextTokens)} of ${formatTokenCount(usage.contextWindowTokens)}`,
    note: "The provider compacts near the window's edge, or restart the provider thread for a fresh one.",
    share: Math.min(100, Math.round((usage.contextTokens / usage.contextWindowTokens) * 100)),
  }
}

function todayRow(today: UsageWindow | null | undefined): UsageChipRow | undefined {
  if (!today || today.turns <= 0) return undefined
  const cost = today.reportedCostTurns > 0 && today.currency ? formatUsageCost(today.costMicros, today.currency) : "cost unavailable"
  const turns = today.turns === 1 ? "1 turn" : `${today.turns} turns`
  const sessions = today.sessions === 1 ? "1 session" : `${today.sessions} sessions`
  return {
    label: "Today",
    value: `${formatTokenCount(today.totalTokens)} tokens · ${cost}`,
    note: [`${turns} in ${sessions}`, "Domovoi's count, not the provider's limit", sessionUsageCostNote(today)]
      .filter((part) => part !== undefined).join(" · "),
  }
}

// The newest history entry is not always a turn: a system receipt such as
// "Worktree restored" is a message with no turn behind it. The walk reads a
// few bounded pages back from the end until it meets an entry that carries a
// turn, and gives up after a fixed number of pages rather than reading a
// session's whole history for one row.
export const latestTurnPageLimit = 10
export const latestTurnPageCount = 3

export async function latestTurnFromHistory(
  load: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionTurn | undefined> {
  let before: string | undefined
  for (let pages = 0; pages < latestTurnPageCount; pages += 1) {
    const page = await load(sessionId, { categories: ["messages"], limit: latestTurnPageLimit, ...(before ? { before } : {}) }, { ...(signal ? { signal } : {}) })
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const turn = page.items[index]!.turn
      if (turn) return turn
    }
    if (!page.hasMore || !page.nextCursor) return undefined
    before = page.nextCursor
  }
  return undefined
}

// A session with no recorded turns has nothing to say for itself, but the day
// may: a fresh session on a busy day still shows today's count. The session
// rows are left out rather than drawn as zeros.
export function sessionHasUsage(usage: SessionUsage | null | undefined): usage is SessionUsage {
  return Boolean(usage && (usage.totalTokens > 0 || usage.byRuntime.length > 0))
}

export function usageChipTriggerText(usage: SessionUsage | null | undefined, today: UsageWindow | null | undefined): string | undefined {
  if (sessionHasUsage(usage)) return usageChipText(usage)
  if (today && today.turns > 0) return `${formatTokenCount(today.totalTokens)} today`
  return undefined
}

export function usageChipRows(input: {
  usage: SessionUsage | null | undefined
  turn: SessionTurn | undefined
  today: UsageWindow | null | undefined
}): UsageChipRow[] {
  const session = sessionHasUsage(input.usage) ? [turnRow(input.turn), sessionRow(input.usage), contextRow(input.usage)] : []
  return [...session, todayRow(input.today)]
    .filter((row): row is UsageChipRow => row !== undefined)
}

export function UsageChip({
  usage,
  today,
  loadLatestTurn,
}: {
  usage: SessionUsage | null
  today: UsageWindow | null | undefined
  // The latest turn record lives in session history, not on the snapshot, so
  // the chip asks for it when it opens rather than keeping every turn. Each
  // open gets its own signal; closing or reopening aborts the read in flight,
  // and a read that is no longer current cannot overwrite a newer one.
  loadLatestTurn?: ((signal: AbortSignal) => Promise<SessionTurn | undefined>) | undefined
}) {
  const [turn, setTurn] = useState<SessionTurn>()
  const readRef = useRef<AbortController | null>(null)
  useEffect(() => () => readRef.current?.abort(), [])
  const text = usageChipTriggerText(usage, today)
  if (!text) return null
  const rows = usageChipRows({ usage, turn, today })
  return (
    <DropdownMenu onOpenChange={(open) => {
      readRef.current?.abort()
      readRef.current = null
      if (!open || !loadLatestTurn || !sessionHasUsage(usage)) return
      const read = new AbortController()
      readRef.current = read
      const current = () => readRef.current === read && !read.signal.aborted
      loadLatestTurn(read.signal).then(
        (latest) => { if (current()) setTurn(latest) },
        () => { if (current()) setTurn(undefined) },
      )
    }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Usage" className="h-7 rounded-full px-2.5 font-machine text-mono-xs text-strong">
          <ChartLineIcon data-icon="inline-start" className="text-muted-foreground" />
          {text}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-[320px] p-0">
        <DropdownMenuLabel className="border-b px-3 py-2 text-eyebrow font-medium tracking-[.13em] text-faint">USAGE</DropdownMenuLabel>
        <div data-testid="usage-rows">
          {rows.map((row, index) => (
            <div key={row.label} data-testid="usage-row" className={index ? "border-t px-3 py-2.5" : "px-3 py-2.5"}>
              <div className="flex items-baseline gap-2">
                <span className="text-eyebrow tracking-[.13em] text-faint">{row.label.toUpperCase()}</span>
                <span className="flex-1" />
                <span className="font-machine text-[11px]">{row.value}</span>
              </div>
              {row.note ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{row.note}</p> : null}
              {row.share !== undefined ? (
                <span role="progressbar" aria-label={`${row.label} share`} aria-valuenow={row.share} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 block h-[5px] overflow-hidden rounded-[3px] bg-muted">
                  <span className="block h-full rounded-[3px] bg-primary" style={{ width: `${row.share}%` }} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
