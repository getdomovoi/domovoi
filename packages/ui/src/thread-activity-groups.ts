import type { ThreadItem } from "@getdomovoi/protocol"

import type { ToolActivity } from "./turn-activity"

export type ThreadRow =
  | { kind: "item", item: ThreadItem }
  | { kind: "activity", id: string, items: ToolActivity[] }

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
export function groupThreadActivity(items: readonly ThreadItem[]): ThreadRow[] {
  const rows: ThreadRow[] = []
  for (const item of items) {
    if (item.kind !== "tool") {
      rows.push({ kind: "item", item })
      continue
    }
    const previous = rows.at(-1)
    if (previous?.kind === "activity") previous.items.push(toActivity(item))
    else rows.push({ kind: "activity", id: `activity-${item.id}`, items: [toActivity(item)] })
  }
  return rows
}
