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

export const sessionHistoryCategories: ReadonlyArray<{
  value: SessionHistoryCategory
  label: string
}> = [
  { value: "messages", label: "Messages" },
  { value: "tools", label: "Tools" },
  { value: "approvals", label: "Approvals" },
  { value: "handoffs", label: "Handoffs" },
  { value: "checkpoints", label: "Checkpoints" },
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

export function sessionHistoryEntryTitle(entry: SessionHistoryEntry): string {
  if (entry.category === "messages") return entry.role === "system" ? "System note" : entry.role
  if (entry.category === "tools" || entry.category === "tests") return entry.title
  if (entry.category === "approvals") return `${entry.operation}: ${entry.decision}`
  if (entry.category === "handoffs") return entry.body
  if (entry.category === "checkpoints") return `Checkpoint: ${entry.label}`
  return entry.action === "created" ? "Annotation created" : "Annotation reply"
}

export function sessionHistoryEntryDetail(entry: SessionHistoryEntry): string | undefined {
  if (entry.category === "messages") return entry.detail ?? entry.body
  if (entry.category === "tools" || entry.category === "tests") return entry.output
  if (entry.category === "approvals") {
    return `Checkpoint ${entry.checkpoint} · ${entry.client}${entry.connectionId ? ` · connection ${entry.connectionId}` : entry.clientId ? ` · declared client ${entry.clientId}` : ""}${entry.explanation ? ` · ${entry.explanation}` : ""}`
  }
  if (entry.category === "handoffs") return entry.detail
  if (entry.category === "checkpoints") return entry.commit
  return entry.body
}
