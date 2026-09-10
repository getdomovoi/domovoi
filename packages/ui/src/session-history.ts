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
  { value: "tools", label: "Tools" },
  { value: "annotations", label: "Annotations" },
  { value: "tests", label: "Tests" },
  { value: "handoffs", label: "Handoffs" },
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
  if (entry.category === "messages") return entry.body
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

export function sessionHistoryEntryDetail(
  entry: SessionHistoryEntry,
  options: { worktreeName?: string | undefined } = {},
): string | undefined {
  // Three fields the design draws that nothing here can fill yet. None of them
  // is satisfied by what this function returns; each is waiting on the daemon.
  //
  // 1. `turn 9 · sonnet-4.6` needs a durable turn record. A message is not a
  //    turn, so the number cannot come from counting rows.
  // 2. `3 tools · 12.4k tokens` needs accounting that is currently wrong: two
  //    adapters forward only selected tool types, and acp.ts gives context
  //    occupancy and total tokens the same value. A number that looks auditable
  //    and is not is worse than no number.
  // 3. Execution duration for an approved operation. `decided in` below is not
  //    that field. Decision latency says how long the agent sat blocked;
  //    execution duration says what the approval cost. Both belong; only the
  //    first can be measured today.
  if (entry.category === "messages") return entry.role
  if (entry.category === "tools" || entry.category === "tests") return `${entry.tool} · ${entry.status}`
  if (entry.category === "approvals") {
    // decisionDurationMs measures how long the decision took, not how long the
    // approved operation ran. Those are different quantities, so the copy names
    // this one. The other is unfilled field 3 above.
    const decidedIn = entry.decisionDurationMs === undefined
      ? ""
      : ` · decided in ${Math.round(entry.decisionDurationMs / 1_000)}s`
    return `decided on ${entry.client}${entry.clientId ? ` · device ${entry.clientId}` : entry.connectionId ? ` · connection ${entry.connectionId}` : ""}${decidedIn}${entry.explanation ? ` · ${entry.explanation}` : ""}`
  }
  if (entry.category === "handoffs") return entry.detail
  if (entry.category === "transfers") {
    if (entry.detail !== undefined) return entry.detail
    const transfer = entry.transfer
    const heldBack = transfer.coverage?.excluded.find(({ kind }) => kind === "ignored-files")?.count
    return `${transfer.sourceMachineId} to ${transfer.targetMachineId} · checkpoint ${transfer.checkpointCommit} · preflight ${transfer.preflight}${heldBack === undefined ? "" : ` · ${heldBack} ignored ${heldBack === 1 ? "file" : "files"} held back`}`
  }
  if (entry.category === "checkpoints") {
    if (!entry.commit) return options.worktreeName ? `worktree ${options.worktreeName}` : undefined
    return `commit ${entry.commit.slice(0, 8)}${options.worktreeName ? ` · worktree ${options.worktreeName}` : ""}`
  }
  return entry.body
}
