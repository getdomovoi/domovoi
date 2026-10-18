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
// Ruled Q374 A: TODAY stays, and the note says this without jargon.
export const unreportedCostNote = "Cost not shown: Domovoi cannot yet tell whether these turns ran on a subscription or an API key."

// Two quantities share the chip, and they are not the same kind of number.
// The context is what the conversation holds now, at most the window. The
// session's tokens are a running total of every request, which grows past
// the window. The chip names the context the next turn runs in, because that
// is the number that decides whether the work continues. A provider that
// reports no context leaves the chip on the running total, and the chip then
// says so, so one number never stands in for the other.
export function usageChipText(usage: SessionUsage): string {
  if (usage.contextTokens !== undefined && usage.contextWindowTokens !== undefined) {
    return formatTokenCount(usage.contextTokens)
  }
  return missingTokens(usage) ?? `${formatTokenCount(usage.totalTokens)} session`
}

// The chip's accessible name says what its number counts in every state.
export function usageChipLabel(usage: SessionUsage | null | undefined, today: UsageWindow | null | undefined): string {
  if (sessionHasUsage(usage)) {
    if (usage.contextTokens !== undefined && usage.contextWindowTokens !== undefined) {
      return `Usage: ${formatTokenCount(usage.contextTokens)} of ${formatTokenCount(usage.contextWindowTokens)} tokens in context`
    }
    const missing = missingTokens(usage)
    if (missing) return `Usage: tokens ${missing} for this session`
    return `Usage: ${formatTokenCount(usage.totalTokens)} tokens this session, no context reported`
  }
  if (today && today.turns > 0) {
    const missing = missingTokens(today)
    return missing ? `Usage: tokens ${missing} today` : `Usage: ${formatTokenCount(today.totalTokens)} tokens today`
  }
  return "Usage"
}

// Turns that reported no tokens (an ACP agent reports only its context) or
// have not reported yet (a running Claude turn reports when it ends) leave no
// count, which is not the same as a count of zero.
function missingTokens(totals: { totalTokens: number; coverage?: UsageWindow["coverage"] | undefined }): "not reported" | "not reported yet" | undefined {
  const coverage = totals.coverage
  if (totals.totalTokens !== 0 || !coverage || coverage.complete + coverage.partial + coverage.legacy > 0) return undefined
  if (coverage.unavailable > 0) return "not reported"
  return coverage.pending > 0 ? "not reported yet" : undefined
}

// Every token row counts the same thing: input (cached input included) and
// output (reasoning included) of every model request, summed. So "in" plus
// "out" is the turn's total, and the session and today are sums of turns.
function turnRow(turn: SessionTurn | undefined): UsageChipRow | undefined {
  if (!turn) return undefined
  const model = turn.reportedModels.at(-1) ?? turn.requestedModel
  const tools = turn.recordedToolCount === 1 ? "1 tool result" : `${turn.recordedToolCount} tool results`
  const { usage } = turn
  const output = usage.outputTokens + usage.reasoningTokens
  const unreported = turn.coverage === "unavailable"
  const running = turn.status === "pending"
  const value = unreported ? "not reported"
    : running && usage.totalTokens === 0 ? "none reported yet"
      : `${usage.inputTokens.toLocaleString("en-US")} in · ${output.toLocaleString("en-US")} out`
  const state = unreported ? "The provider reported no usage for this turn"
    : running ? "Running, counted so far"
      : turn.coverage === "partial" ? "Partly reported" : undefined
  const cached = !unreported && usage.cachedInputTokens > 0
    ? `${usage.cachedInputTokens.toLocaleString("en-US")} of the input was cached`
    : undefined
  return {
    label: "This turn",
    value,
    note: [state, cached, model, tools].filter((part): part is string => Boolean(part)).join(" · "),
  }
}

// A partly reported turn counted less than every request it made (a resumed
// Claude query's first turn leaves its subagents out), so a sum over it can
// only be low, and the row says so.
function partlyReported(coverage: UsageWindow["coverage"] | undefined): string | undefined {
  const partial = coverage?.partial ?? 0
  if (partial === 0) return undefined
  return `${partial === 1 ? "1 turn was" : `${partial} turns were`} partly reported, so the count may be low.`
}

function sessionRow(usage: SessionUsage): UsageChipRow {
  return {
    label: "This session",
    value: missingTokens(usage) ?? `${formatTokenCount(usage.totalTokens)} tokens`,
    note: [
      "Input and output of every model request, cached input included: the same count as This turn and Today.",
      partlyReported(usage.coverage),
      unreportedCostNote,
    ].filter((part): part is string => Boolean(part)).join(" "),
  }
}

function contextRow(usage: SessionUsage): UsageChipRow | undefined {
  if (usage.contextTokens === undefined || usage.contextWindowTokens === undefined) return undefined
  return {
    label: "Context",
    value: `${formatTokenCount(usage.contextTokens)} of ${formatTokenCount(usage.contextWindowTokens)}`,
    note: "What the conversation holds at the provider's last report, not a running total. The provider compacts near the window's edge, or restart the provider thread for a fresh one.",
    share: Math.min(100, Math.round((usage.contextTokens / usage.contextWindowTokens) * 100)),
  }
}

// Today counts the turns that started today, so a session that began
// yesterday can hold more than today does.
function todayRow(today: UsageWindow | null | undefined): UsageChipRow | undefined {
  if (!today || today.turns <= 0) return undefined
  const turns = today.turns === 1 ? "1 turn" : `${today.turns} turns`
  const sessions = today.sessions === 1 ? "1 session" : `${today.sessions} sessions`
  return {
    label: "Today",
    value: missingTokens(today) ?? `${formatTokenCount(today.totalTokens)} tokens`,
    note: [`${turns} started today, in ${sessions}`, "Domovoi's count, not the provider's limit", unreportedCostNote].join(" · "),
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

// The note under USAGE, one per state the design draws. The api state (a
// price, the key's owner billed) waits on the wire saying what pays for a
// runtime (CX-8), so a client tells apart only a reported window, drawn as the
// ring, and none. The ring's note does not say why there is no price, since
// nothing on the wire says this is a subscription.
export function usageConnectionNote(usage: SessionUsage | null | undefined): string {
  const windows = usage?.providerLimits?.windows ?? []
  if (windows.length === 0) return "No window reported, so no dial. The chip falls back to tokens alone."
  const lead = "The provider reported its usage window, so the chip carries the window rather than a price."
  return windows.length > 1 ? `${lead} Two windows run at once and the ring shows the tighter one.` : lead
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

// What the popover draws: the latest turn and the totals read after it. The
// chip's own totals are read when a turn starts and ends, while the turn is
// read when the popover opens; side by side, a running turn could outgrow the
// session total read at its start (walk F9). The daemon's counters only grow,
// so totals read after the turn are never below it.
export type UsageReading = {
  turn: SessionTurn | undefined
  usage: SessionUsage
  today: UsageWindow | null
}

export async function readUsage(load: {
  turn: () => Promise<SessionTurn | undefined>
  session: () => Promise<SessionUsage>
  today: () => Promise<UsageWindow>
}): Promise<UsageReading> {
  const turn = await load.turn()
  const [usage, today] = await Promise.all([load.session(), load.today().catch(() => null)])
  return { turn, usage, today }
}

// A session with no recorded turns has nothing to say for itself, but the day
// may: a fresh session on a busy day still shows today's count. The session
// rows are left out rather than drawn as zeros.
export function sessionHasUsage(usage: SessionUsage | null | undefined): usage is SessionUsage {
  return Boolean(usage && (usage.totalTokens > 0 || usage.byRuntime.length > 0))
}

export function usageChipTriggerText(usage: SessionUsage | null | undefined, today: UsageWindow | null | undefined): string | undefined {
  if (sessionHasUsage(usage)) return usageChipText(usage)
  if (today && today.turns > 0) {
    const missing = missingTokens(today)
    return missing ? `${missing} today` : `${formatTokenCount(today.totalTokens)} today`
  }
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
  loadUsageReading,
}: {
  usage: SessionUsage | null
  today: UsageWindow | null | undefined
  // The latest turn record lives in session history, not on the snapshot, so
  // the chip asks for it, with totals read after it (readUsage), when it opens
  // rather than keeping every turn. Each open gets its own signal; closing or
  // reopening aborts the read in flight, and a read that is no longer current
  // cannot overwrite a newer one. Until a reading arrives, or when it fails,
  // the popover draws the chip's own totals and no turn.
  loadUsageReading?: ((signal: AbortSignal) => Promise<UsageReading>) | undefined
}) {
  const [reading, setReading] = useState<UsageReading>()
  const readRef = useRef<AbortController | null>(null)
  useEffect(() => () => readRef.current?.abort(), [])
  const text = usageChipTriggerText(usage, today)
  const ring = usageChipRing(usage)
  if (!text) return null
  const rows = reading
    ? usageChipRows({ usage: reading.usage, turn: reading.turn, today: reading.today })
    : usageChipRows({ usage, turn: undefined, today })
  return (
    <DropdownMenu onOpenChange={(open) => {
      readRef.current?.abort()
      readRef.current = null
      setReading(undefined)
      if (!open || !loadUsageReading || !sessionHasUsage(usage)) return
      const read = new AbortController()
      readRef.current = read
      const current = () => readRef.current === read && !read.signal.aborted
      loadUsageReading(read.signal).then(
        (next) => { if (current()) setReading(next) },
        () => { if (current()) setReading(undefined) },
      )
    }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={usageChipLabel(usage, today)} className="h-7 rounded-full px-2.5 font-machine text-mono-xs text-strong">
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
        <p data-testid="usage-connection-note" className="m-0 border-b px-3 py-2 text-[11px] leading-[1.5] text-muted-foreground">{usageConnectionNote(usage)}</p>
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
