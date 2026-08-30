import type {
  RpcParams,
  SessionHistoryCategory,
  SessionHistoryEntry,
  SessionHistoryPage,
} from "@getdomovoi/protocol"
import { maximumRetainedSessionHistoryItems as retainedHistoryBudget } from "@getdomovoi/protocol"

export const maximumRetainedSessionHistoryItems = retainedHistoryBudget

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
    return `Checkpoint ${entry.checkpoint} · ${entry.client}${entry.explanation ? ` · ${entry.explanation}` : ""}`
  }
  if (entry.category === "handoffs") return entry.detail
  if (entry.category === "checkpoints") return entry.commit
  return entry.body
}
