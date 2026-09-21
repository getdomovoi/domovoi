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
import { formatTokenCount } from "./session-usage.js"

// The v2 composer carries one usage chip with three states of one shape:
// tokens, a separator, then a price or a ring. A reported cost gives
// "42.1k · $0.38". No cost and no provider window gives "42.1k" alone with the
// separator hidden: a limit the provider has not stated is not drawn, and the
// popover's last row says so. The ring, for a subscription whose provider
// reports its window, waits on the wire carrying that window. The rows are
// this turn, this session, the context with its share of the window, today
// from Domovoi's own accounting (which says so), and the provider window.

export type UsageChipRow = {
  label: string
  value: string
  note?: string | undefined
  // Percent of a bounded quantity, drawn as a bar; only the context has one.
  share?: number | undefined
}

// Until the wire says whether a session runs on a subscription or an API
// key, every session is the unreported state: tokens alone, no separator, no
// money. A provider reports a dollar figure for a subscription turn too, and
// that is money nobody is charged. The priced state and the ring wait on the
// connection kind and the provider window (asks 5 and 6).
export const unreportedCostNote = "Cost not shown: the wire does not say yet whether these turns ran on a subscription or an API key."

export function usageChipText(usage: SessionUsage): string {
  return formatTokenCount(usage.totalTokens)
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
  return {
    label: "This session",
    value: `${formatTokenCount(usage.totalTokens)} tokens`,
    note: unreportedCostNote,
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
  const turns = today.turns === 1 ? "1 turn" : `${today.turns} turns`
  const sessions = today.sessions === 1 ? "1 session" : `${today.sessions} sessions`
  return {
    label: "Today",
    value: `${formatTokenCount(today.totalTokens)} tokens`,
    note: [`${turns} in ${sessions}`, "Domovoi's count, not the provider's limit", unreportedCostNote].join(" · "),
  }
}

function providerWindowRow(): UsageChipRow {
  return {
    label: "Provider window",
    value: "not reported",
    note: "This provider has not said what the limit is, so Domovoi draws no dial rather than guessing one.",
  }
}

// The signed v2 chip carries a 13px ring: a muted track and one arc, drawn at
// r=5.5 so the circumference is 34.56, offset from the top. Two provider
// windows run at once and the ring shows the tighter one, because that is the
// window that stops the work first. The label names which window it drew, so
// the ring is never a number without a unit.
export const usageRingCircumference = 34.56
export const usageRingWarningPercent = 85

export type UsageChipRing = {
  percent: number
  offset: number
  warning: boolean
  label: string
}

function providerWindowName(kind: "primary" | "secondary", duration: number | undefined): string {
  if (duration === 300) return "5 hour window"
  if (duration === 10_080) return "weekly window"
  return kind === "primary" ? "primary window" : "secondary window"
}

function formatPercent(percent: number): string {
  return percent.toLocaleString("en-US", { maximumFractionDigits: 1 })
}

function formatResetTime(resetsAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt))
}

export function usageChipRing(usage: SessionUsage | null | undefined): UsageChipRing | undefined {
  const windows = usage?.providerLimits?.windows
  if (!windows || windows.length === 0) return undefined
  const tightest = windows.reduce((worst, window) => window.usedPercent > worst.usedPercent ? window : worst)
  const percent = tightest.usedPercent
  const name = providerWindowName(tightest.kind, tightest.windowDurationMinutes)
  const label = [
    `${formatPercent(percent)} percent of the ${name}`,
    tightest.resetsAt ? `resets ${formatResetTime(tightest.resetsAt)}` : undefined,
    windows.length > 1 ? "which is the tighter of the two" : undefined,
  ].filter((part): part is string => Boolean(part)).join(", ")
  return {
    percent,
    offset: usageRingCircumference * (1 - percent / 100),
    warning: percent >= usageRingWarningPercent,
    label,
  }
}

function providerWindowLabel(kind: "primary" | "secondary", duration: number | undefined): string {
  if (duration === 300) return "5-hour limit"
  if (duration === 10_080) return "Weekly limit"
  return kind === "primary" ? "Primary limit" : "Secondary limit"
}

function providerWindowRows(usage: SessionUsage): UsageChipRow[] {
  if (!usage.providerLimits) return [providerWindowRow()]
  const provider = usage.providerLimits.provider === "codex"
    ? "Codex"
    : usage.providerLimits.provider
  return usage.providerLimits.windows.map((window) => ({
    label: providerWindowLabel(window.kind, window.windowDurationMinutes),
    value: `${window.usedPercent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% used`,
    note: [
      window.resetsAt
        ? `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(window.resetsAt))}`
        : undefined,
      `Reported by ${provider}`,
    ].filter((part): part is string => Boolean(part)).join(" · "),
    share: window.usedPercent,
  }))
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
  return [...session, todayRow(input.today), ...(input.usage && session.length > 0 ? providerWindowRows(input.usage) : [])]
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
  const ring = usageChipRing(usage)
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
          {ring ? (
            <>
              <span aria-hidden="true" className="text-faint">·</span>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" role="img" aria-label={ring.label} className="shrink-0">
                <circle cx="7" cy="7" r="5.5" stroke="var(--muted)" strokeWidth="2" />
                <circle
                  cx="7" cy="7" r="5.5"
                  stroke={ring.warning ? "var(--warning)" : "var(--primary)"}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={usageRingCircumference}
                  strokeDashoffset={ring.offset.toFixed(2)}
                  transform="rotate(-90 7 7)"
                />
              </svg>
            </>
          ) : null}
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
