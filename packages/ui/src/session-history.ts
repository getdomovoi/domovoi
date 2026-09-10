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

// The design draws five of these and the daemon stamps seven, so the drawn ones
// lead and carry the design's words. A turn is the protocol's own unit.
//
// Transfers is not among them yet, and this category is not it. `handoffs` holds
// provider handoffs, written at apps/daemon/src/server.ts:5812 as "Handed off
// codex / gpt-5.3-codex to claude-code / sonnet-4.6." A machine transfer has a
// preflight, a holdback and a conflict path; a provider handoff happens at a
// turn boundary. Naming one after the other would make the filter lie in both
// directions, so Handoffs keeps its own word and Transfers waits for a category
// the daemon stamps when a session moves.
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

export function sessionHistoryEntryTitle(entry: SessionHistoryEntry): string {
  if (entry.category === "messages") return entry.role === "system" ? "System note" : entry.role
  if (entry.category === "tools" || entry.category === "tests") return entry.title
  if (entry.category === "approvals") return `${entry.operation}: ${entry.decision}`
  // handoffs holds provider handoffs; transfers holds machine transfers. They
  // are different events and each names itself, rather than sharing a branch
  // because both happen to carry a body.
  if (entry.category === "handoffs" || entry.category === "transfers") return entry.body
  if (entry.category === "checkpoints") return `Checkpoint: ${entry.label}`
  // Named rather than defaulted. A default here would have absorbed transfers
  // silently instead of failing to compile, and would absorb the next category
  // the protocol adds the same way.
  // No trailing default. With annotations named, the compiler reports every
  // category as handled, and a category added to the protocol later fails to
  // compile here rather than rendering its body as a title.
  return entry.action === "created" ? "Annotation created" : "Annotation reply"
}

export function sessionHistoryEntryDetail(entry: SessionHistoryEntry): string | undefined {
  if (entry.category === "messages") return entry.detail ?? entry.body
  if (entry.category === "tools" || entry.category === "tests") return entry.output
  if (entry.category === "approvals") {
    return `Checkpoint ${entry.checkpoint} · ${entry.client}${entry.connectionId ? ` · connection ${entry.connectionId}` : entry.clientId ? ` · declared client ${entry.clientId}` : ""}${entry.explanation ? ` · ${entry.explanation}` : ""}`
  }
  if (entry.category === "handoffs") return entry.detail
  if (entry.category === "transfers") {
    if (entry.detail !== undefined) return entry.detail
    const { sourceMachineId, targetMachineId, checkpointCommit, preflight } = entry.transfer
    return `${sourceMachineId} to ${targetMachineId} · checkpoint ${checkpointCommit} · preflight ${preflight}`
  }
  if (entry.category === "checkpoints") return entry.commit
  return entry.body
}
