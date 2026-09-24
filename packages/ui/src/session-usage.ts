import type { UsageWindowParams, WorkspaceSnapshot } from "@getdomovoi/protocol"

function compact(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor
  const digits = scaled < 100 ? 1 : 0
  return `${Number(scaled.toFixed(digits))}${suffix}`
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return compact(tokens, 1_000, "k")
  return compact(tokens, 1_000_000, "M")
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
