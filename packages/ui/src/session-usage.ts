import type { SessionUsage, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type SessionUsageTotals = Pick<
  SessionUsage,
  "costMicros" | "currency" | "reportedCostTurns" | "unavailableCostTurns"
>

function compact(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor
  const digits = scaled < 10 ? 1 : 0
  return `${Number(scaled.toFixed(digits))}${suffix}`
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return compact(tokens, 1_000, "k")
  return compact(tokens, 1_000_000, "M")
}

export function formatUsageCost(costMicros: number, currency: string): string {
  const amount = costMicros / 1_000_000
  const value = amount >= 0.01 || amount === 0 ? amount.toFixed(2) : amount.toFixed(4)
  return currency === "USD" ? `$${value}` : `${currency} ${value}`
}

export function sessionUsageReportedCost(usage: SessionUsageTotals): string | undefined {
  if (usage.reportedCostTurns <= 0 || !usage.currency) return undefined
  return formatUsageCost(usage.costMicros, usage.currency)
}

export function sessionUsageCostNote(usage: SessionUsageTotals): string | undefined {
  if (usage.unavailableCostTurns <= 0) return undefined
  const turns = usage.unavailableCostTurns === 1
    ? "1 turn reported no cost"
    : `${usage.unavailableCostTurns} turns reported no cost`
  return usage.reportedCostTurns > 0
    ? `${turns}, so this total is partial.`
    : `${turns}, so Domovoi has no cost to show.`
}

export function sessionUsageFetchKey(snapshot: WorkspaceSnapshot | null): string | null {
  const sessionId = snapshot?.activeSessionId ?? null
  if (!snapshot || !sessionId) return null
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return null
  return `${sessionId}:${session.activeTurnId ?? "idle"}`
}
