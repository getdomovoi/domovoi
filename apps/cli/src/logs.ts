import { auditQueryPageSchema } from "@getdomovoi/protocol"

import type { RpcCall } from "./pair.js"

// One-shot read of the machine's own audit log over the client's channel.
// Nothing is uploaded: the entries come to this terminal and stop here. There
// is no --follow because audit.query is a paged query, not a subscription; a
// poll that called itself "following" would claim a stream that does not exist.
export type LogsQuery = { limit: number; action?: string; outcome?: string; session?: string; before?: string }

export async function readLogs(input: { call: RpcCall; query: LogsQuery }) {
  const params: Record<string, unknown> = { limit: input.query.limit }
  if (input.query.action) params.action = input.query.action
  if (input.query.outcome) params.outcome = input.query.outcome
  if (input.query.session) params.sessionId = input.query.session
  if (input.query.before) params.before = input.query.before
  return auditQueryPageSchema.parse(await input.call("audit.query", params))
}

export function renderLogs(page: ReturnType<typeof auditQueryPageSchema.parse>): string {
  const lines = page.entries.map((entry) => {
    const actor = entry.actor.kind === "client" ? `client ${"deviceId" in entry.actor && entry.actor.deviceId ? String(entry.actor.deviceId).slice(0, 15) : ""}`.trim()
      : entry.actor.kind === "machine" ? `machine ${String((entry.actor as { machineId?: string }).machineId ?? "").slice(0, 16)}`
      : entry.actor.kind
    const where = entry.sessionId ? ` session ${entry.sessionId}` : ""
    const target = entry.target ? ` ${entry.target}` : ""
    const detail = entry.detail ? ` ${entry.detail.replace(/\s+/g, " ").slice(0, 160)}` : ""
    return `${entry.occurredAt} ${entry.outcome.padEnd(9)} ${entry.action}${target} [${actor}]${where}${detail}`
  })
  if (page.hasMore && page.nextCursor) lines.push(`more: run again with --before ${page.nextCursor}`)
  return lines.length === 0 ? "no entries\n" : `${lines.join("\n")}\n`
}
