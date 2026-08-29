import type {
  SessionHistoryCategory,
  SessionHistoryEntry,
  SessionHistoryPage,
} from "@getdomovoi/protocol"

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
  return {
    sessionId: current.sessionId,
    items: [...older.items.filter((item) => !currentIds.has(item.id)), ...current.items],
    hasMore: older.hasMore,
    ...(older.nextCursor ? { nextCursor: older.nextCursor } : {}),
  }
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
