import type { QueuedSessionSend, WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { HandheldClient } from "./lib/protocol-facts"

export function sendDelivery(
  session: WorkspaceSnapshot["sessions"][number],
): { delivery?: "next-turn-replace" } {
  return session.activeTurnId ? { delivery: "next-turn-replace" } : {}
}

export function queuedCancelParams(
  queued: QueuedSessionSend | undefined,
  sessionId: string,
  queueId: string,
  client: HandheldClient,
): { sessionId: string, queueId: string, client: HandheldClient } | undefined {
  if (queued?.sessionId !== sessionId || queued.id !== queueId) return undefined
  return { sessionId, queueId, client }
}
