import type { ThreadItem } from "@getdomovoi/protocol"

import type { ToolActivity } from "./turn-activity"

export type ThreadRow =
  | { kind: "item", item: ThreadItem }
  | { kind: "activity", id: string, items: ToolActivity[], sources: readonly ThreadItem[] }

function toActivity(item: Extract<ThreadItem, { kind: "tool" }>): ToolActivity {
  return {
    id: item.id,
    name: item.tool,
    argument: item.title,
    outcome: item.status,
    failed: item.status === "failed",
    ...(item.output ? { log: item.output } : {}),
  }
}

// v2 shows one collapsed row for a turn's tool calls rather than one card each.
// Only a consecutive run collapses: a tool call after a message belongs to what
// the agent said next, and merging across that would rewrite the order of
// events.
//
// A streaming reply rebuilds the thread array on every token but keeps the
// identity of every item it did not touch. Pass the rows from the last call as
// `previous` and any row whose source items are unchanged is returned as the
// same object, so a memoised row component can skip it.
export function groupThreadActivity(
  items: readonly ThreadItem[],
  previous: readonly ThreadRow[] = [],
): ThreadRow[] {
  const rows: ThreadRow[] = []
  for (const item of items) {
    if (item.kind !== "tool") {
      rows.push({ kind: "item", item })
      continue
    }
    const last = rows.at(-1)
    if (last?.kind === "activity") {
      last.items.push(toActivity(item))
      last.sources = [...last.sources, item]
      continue
    }
    rows.push({ kind: "activity", id: `activity-${item.id}`, items: [toActivity(item)], sources: [item] })
  }
  return rows.map((row, index) => reuse(row, previous[index]))
}

function reuse(row: ThreadRow, before: ThreadRow | undefined): ThreadRow {
  if (!before || before.kind !== row.kind) return row
  if (before.kind === "item" && row.kind === "item") return before.item === row.item ? before : row
  if (before.kind === "activity" && row.kind === "activity") {
    return sameSources(before.sources, row.sources) ? before : row
  }
  return row
}

function sameSources(before: readonly ThreadItem[], next: readonly ThreadItem[]): boolean {
  return before.length === next.length && before.every((item, index) => item === next[index])
}
