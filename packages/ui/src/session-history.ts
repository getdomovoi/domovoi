import type { StatusMeaning } from "./status-dot"
import type {
  RpcParams,
  SessionHistoryCategory,
  SessionHistoryEntry,
  SessionHistoryPage,
} from "@getdomovoi/protocol"
import { maximumRetainedSessionHistoryItems as retainedHistoryBudget } from "@getdomovoi/protocol"

export const maximumRetainedSessionHistoryItems = retainedHistoryBudget
export const sessionHistorySearchDebounceMs = 250

export type SessionHistoryRequest<T> = {
  debounce: boolean
  load: (signal: AbortSignal) => Promise<T>
  onSuccess: (value: T) => void
  onError?: (cause: unknown) => void
  onSettled?: () => void
}

export class SessionHistoryRequestController<T> {
  #generation = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #abort: AbortController | undefined

  schedule(request: SessionHistoryRequest<T>): void {
    this.cancel()
    const generation = this.#generation
    const run = () => {
      this.#timer = undefined
      const abort = new AbortController()
      this.#abort = abort
      void request.load(abort.signal).then(
        (value) => {
          if (generation === this.#generation && !abort.signal.aborted) request.onSuccess(value)
        },
        (cause: unknown) => {
          if (generation === this.#generation && !abort.signal.aborted) request.onError?.(cause)
        },
      ).finally(() => {
        if (generation === this.#generation && !abort.signal.aborted) request.onSettled?.()
        if (this.#abort === abort) this.#abort = undefined
      })
    }
    if (request.debounce) this.#timer = setTimeout(run, sessionHistorySearchDebounceMs)
    else run()
  }

  cancel(): void {
    this.#generation += 1
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#abort?.abort()
    this.#abort = undefined
  }

  dispose(): void {
    this.cancel()
  }
}

export type SessionHistoryWindowState = {
  page: SessionHistoryPage | undefined
  historyWindowed: boolean
  historyRefresh: number
}

export function latestSessionHistoryRequest(
  categories: readonly SessionHistoryCategory[],
  query: string,
): Omit<RpcParams<"session.history">, "sessionId"> {
  const trimmedQuery = query.trim()
  return {
    categories: [...categories],
    ...(trimmedQuery ? { query: trimmedQuery } : {}),
    limit: 50,
  }
}

export function resetSessionHistoryWindow(
  current: SessionHistoryWindowState,
): SessionHistoryWindowState {
  return {
    page: undefined,
    historyWindowed: false,
    historyRefresh: current.historyRefresh + 1,
  }
}

// A deep link into the pane names one category. It is pressed more than once,
// and the second press carries the same category as the first, so the category
// alone cannot say that a new request happened. The id is what separates them.
export type SessionHistoryFocus = {
  category: SessionHistoryCategory
  requestId: number
}

// The drawn filters lead and carry the design's words. A turn is the protocol's
// own unit.
//
// Handoffs holds provider switches at a turn boundary. Machine transfers have
// their own protocol category, with preflight and holdback facts. Keep the
// provider filter's name distinct when the Transfers filter is added here.
//
// The three the design does not draw stay: dropping the filters would leave
// those entries recorded and unreachable.
export const sessionHistoryCategories: ReadonlyArray<{
  value: SessionHistoryCategory
  label: string
}> = [
  { value: "messages", label: "Turns" },
  { value: "approvals", label: "Approvals" },
  { value: "checkpoints", label: "Checkpoints" },
  { value: "transfers", label: "Transfers" },
  { value: "handoffs", label: "Handoffs" },
  { value: "tools", label: "Tools" },
  { value: "annotations", label: "Annotations" },
  { value: "tests", label: "Tests" },
]

export function mergeOlderHistory(
  current: SessionHistoryPage,
  older: SessionHistoryPage,
): SessionHistoryPage {
  const currentIds = new Set(current.items.map((item) => item.id))
  const items = [...older.items.filter((item) => !currentIds.has(item.id)), ...current.items]
    .slice(0, maximumRetainedSessionHistoryItems)
  return {
    sessionId: current.sessionId,
    items,
    hasMore: older.hasMore,
    ...(older.nextCursor ? { nextCursor: older.nextCursor } : {}),
  }
}

export function historyWindowedAfterMerge(
  historyWindowed: boolean,
  current: SessionHistoryPage,
  older: SessionHistoryPage,
): boolean {
  if (historyWindowed) return true
  const currentIds = new Set(current.items.map((item) => item.id))
  const uniqueItemCount = current.items.length
    + older.items.filter((item) => !currentIds.has(item.id)).length
  return uniqueItemCount > maximumRetainedSessionHistoryItems
}

// The row's title is the prose of what happened, and its meta is the machine
// line beneath. A message therefore leads with what it said rather than with
// which side said it, and a checkpoint leads with the reason it was taken: the
// daemon writes the short sha into every checkpoint label, and the commit is
// the meta's job, so the title drops it rather than saying it twice.
export function sessionHistoryEntryTitle(entry: SessionHistoryEntry): string {
  if (entry.category === "messages") {
    const [first = ""] = entry.body.split("\n")
    return first.trim() || (entry.role === "system" ? "System note" : entry.role)
  }
  if (entry.category === "tools" || entry.category === "tests") return entry.title
  if (entry.category === "approvals") return `${entry.operation}: ${entry.decision}`
  if (entry.category === "handoffs" || entry.category === "transfers") return entry.body
  if (entry.category === "checkpoints") return `Checkpoint: ${withoutCommitPrefix(entry.label, entry.commit)}`
  return entry.action === "created" ? "Annotation created" : "Annotation reply"
}

function withoutCommitPrefix(label: string, commit: string | undefined): string {
  if (!commit) return label
  const prefix = `${commit.slice(0, 8)} · `
  return label.startsWith(prefix) ? label.slice(prefix.length) : label
}

// The content a row produced is not the row. A forty-line tool output inside a
// history row stops the list scanning as a list, so the body lives on the row's
// expanded state and the row keeps its one line.
export function sessionHistoryEntryBody(entry: SessionHistoryEntry): string | undefined {
  // A message's detail is the diagnostic behind a system note; it belongs to
  // the body, beneath the words, rather than being dropped because the meta
  // line now carries the turn instead.
  if (entry.category === "messages") return entry.detail ? `${entry.body}\n${entry.detail}` : entry.body
  if (entry.category === "tools" || entry.category === "tests") return entry.output
  return undefined
}

// The row draws a dot, and StatusDot never lets colour carry the meaning alone.
// Every category already records its own outcome, so nothing here is invented:
// a tool or a test carries `status`, an approval carries `decision`, and a row
// that has no outcome of its own says so rather than borrowing one.
export function sessionHistoryEntryOutcome(
  entry: SessionHistoryEntry,
): { meaning: StatusMeaning; label: string } {
  if (entry.category === "tools" || entry.category === "tests") {
    const meaning = entry.status === "completed"
      ? "online"
      : entry.status === "failed"
        ? "offline"
        : entry.status === "declined"
          ? "waiting"
          : "idle"
    return { meaning, label: entry.status }
  }
  if (entry.category === "approvals") {
    const denied = entry.decision === "deny" || entry.decision === "deny-explain"
    return { meaning: denied ? "offline" : "online", label: entry.decision }
  }
  return { meaning: "idle", label: "recorded" }
}

// 12.4k reads at a glance where 12400 does not, but a rounded 842 would read as
// nothing at all, so small counts stay exact.
function tokenLabel(totalTokens: number): string {
  if (totalTokens >= 1_000_000) return `${(totalTokens / 1_000_000).toFixed(1)}M`
  if (totalTokens >= 1_000) return `${(totalTokens / 1_000).toFixed(1)}k`
  return `${totalTokens}`
}

// The turn says how complete its own accounting is, and the row repeats that
// rather than drawing a floor as a total. A pending turn has nothing final to
// report, and an unavailable one has nothing at all: neither gets a zero, which
// would read as a measurement rather than as an absence.
function turnMeta(entry: SessionHistoryEntry): string | undefined {
  const turn = entry.turn
  if (!turn) return undefined
  const head = `turn ${turn.ordinal} · ${turn.requestedModel}`
  if (turn.coverage === "pending") return `${head} · running`
  if (turn.coverage === "unavailable") return `${head} · usage unavailable`
  const tools = `${turn.recordedToolCount} tool${turn.recordedToolCount === 1 ? "" : "s"}`
  const counted = `${head} · ${tools} · ${tokenLabel(turn.usage.totalTokens)} tokens`
  return turn.coverage === "partial" ? `${counted} · partial` : counted
}

export function sessionHistoryEntryDetail(
  entry: SessionHistoryEntry,
  options: { worktreeName?: string | undefined } = {},
): string | undefined {
  // Two of the four things this comment used to list are filled now. CX1 fixed
  // the accounting and CX2 gave a row a durable link to its turn, so
  // `turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens` is drawn from the record
  // rather than from counting rows. What the turn reports about its own
  // completeness is drawn with it: a number that looks auditable and is not is
  // worse than no number, and `coverage` is the daemon saying how much of the
  // turn it actually saw.
  //
  // The design's three fork-bearing turn rows are a design error rather than a
  // gap, settled 2026-09-10, and the design is what changes. Fork restores a
  // worktree, and turns do not each have one: most turns write nothing, so
  // forking "from turn 8" and "from turn 9" lands on identical filesystem state,
  // and session.fork does not replay conversation either. The affordance would
  // promise a precision it cannot deliver. CX2 gave a turn an identity; it did
  // not give it a state, and only a checkpoint names one. Checkpoint-only is the
  // rule, not a narrowing of the drawing.
  //
  // One thing here is still unfilled, and it is the daemon's:
  //
  // 1. Execution duration for an approved operation. `decided in` below is not
  //    that field. Decision latency says how long the agent sat blocked;
  //    execution duration says what the approval cost. Both belong; only the
  //    first can be measured today. That is CX3.
  if (entry.category === "messages") return turnMeta(entry) ?? entry.role
  if (entry.category === "tools" || entry.category === "tests") return `${entry.tool} · ${entry.status}`
  if (entry.category === "approvals") {
    // decisionDurationMs measures how long the decision took, not how long the
    // approved operation ran. Those are different quantities, so the copy names
    // this one. The other is unfilled field 4 above.
    const decidedIn = entry.decisionDurationMs === undefined
      ? ""
      : ` · decided in ${Math.round(entry.decisionDurationMs / 1_000)}s`
    // The checkpoint and the connection are the evidence of what was approved
    // and from where. A declared client id is what a hello may assert without
    // a paired credential, so it is named as declared, never as a device.
    const from = entry.connectionId
      ? ` · connection ${entry.connectionId}`
      : entry.clientId ? ` · declared client ${entry.clientId}` : ""
    return `checkpoint ${entry.checkpoint} · decided on ${entry.client}${from}${decidedIn}${entry.explanation ? ` · ${entry.explanation}` : ""}`
  }
  if (entry.category === "handoffs") return entry.detail
  if (entry.category === "transfers") {
    if (entry.detail !== undefined) return entry.detail
    const transfer = entry.transfer
    const heldBack = transfer.coverage?.excluded.find(({ kind }) => kind === "ignored-files")?.count
    return `${transfer.sourceMachineId} to ${transfer.targetMachineId} · checkpoint ${transfer.checkpointCommit} · preflight ${transfer.preflight}${heldBack === undefined ? "" : ` · ${heldBack} ignored ${heldBack === 1 ? "file" : "files"} held back`}`
  }
  if (entry.category === "checkpoints") {
    // CX5 made the reason a field rather than a word inside the label. The
    // session-start row is the one the design draws without a fork, and its meta
    // says why instead of naming a commit the row cannot go back past. A legacy
    // row carries no reason at all, and absent is its own answer: it reads the
    // way it always did rather than being guessed into this branch.
    if (entry.reason === "session-start") return "session start · nothing to revert past this"
    if (!entry.commit) return options.worktreeName ? `worktree ${options.worktreeName}` : undefined
    return `commit ${entry.commit.slice(0, 8)}${options.worktreeName ? ` · worktree ${options.worktreeName}` : ""}`
  }
  return entry.body
}
