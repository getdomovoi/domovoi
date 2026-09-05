import type { SessionUsage, UsageWindow, UsageWindowParams, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type SessionUsageTotals = Pick<
  SessionUsage,
  "costMicros" | "currency" | "reportedCostTurns" | "unavailableCostTurns"
>

export type UsageTodayTotals = Pick<
  UsageWindow,
  "sessions" | "turns" | "totalTokens" | "costMicros" | "currency" | "reportedCostTurns" | "unavailableCostTurns"
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

export function usageWindowFetchKey(snapshot: WorkspaceSnapshot | null): string | null {
  if (!snapshot) return null
  return snapshot.sessions
    .map((session) => `${session.id}:${session.activeTurnId ?? "idle"}`)
    .join(",") || "idle"
}

export function usageTodayWindow(now: Date): UsageWindowParams {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const maximumTimeoutMs = 2_147_483_647

export function usageTodayRefreshDelayMs(now: Date): number {
  return Math.min(Date.parse(usageTodayWindow(now).end) - now.getTime(), maximumTimeoutMs)
}

export function usageTodayReadout(usage: UsageTodayTotals): string | undefined {
  if (usage.turns <= 0) return undefined
  const cost = sessionUsageReportedCost(usage)
  return cost ? `${cost} today` : `${formatTokenCount(usage.totalTokens)} tokens today`
}

export function usageTodayDetail(usage: UsageTodayTotals): string | undefined {
  if (usage.turns <= 0) return undefined
  const turns = usage.turns === 1 ? "1 turn" : `${usage.turns} turns`
  const sessions = usage.sessions === 1 ? "1 session" : `${usage.sessions} sessions`
  const summary = `${formatTokenCount(usage.totalTokens)} tokens across ${turns} in ${sessions} today.`
  const note = sessionUsageCostNote(usage)
  return note ? `${summary} ${note}` : summary
}

export function sessionContextReadout(usage: {
  contextTokens?: number | undefined
  contextWindowTokens?: number | undefined
}): string | undefined {
  const { contextTokens, contextWindowTokens } = usage
  if (contextTokens === undefined || contextWindowTokens === undefined) return undefined
  return `${formatTokenCount(contextTokens)} ctx`
}

export function sessionContextShare(usage: {
  contextTokens?: number | undefined
  contextWindowTokens?: number | undefined
}): string | undefined {
  const { contextTokens, contextWindowTokens } = usage
  if (contextTokens === undefined || contextWindowTokens === undefined) return undefined
  return `${formatTokenCount(contextTokens)} of ${formatTokenCount(contextWindowTokens)} context tokens`
}
