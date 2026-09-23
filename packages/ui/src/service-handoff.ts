import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

// J24, ruled 2026-09-23: the switch to the login service refuses while a turn
// runs or a gate waits, and the refusal names which. Read from the snapshot
// the client already holds; nothing is asked of the daemon and nothing is
// interrupted.
export function serviceHandoffRefusal(snapshot: Pick<WorkspaceSnapshot, "sessions" | "approvals">): string | undefined {
  const title = (sessionId: string) => snapshot.sessions.find((session) => session.id === sessionId)?.title ?? sessionId
  const running = snapshot.sessions.filter((session) => session.state === "active" && session.activeTurnId).map((session) => session.title)
  const waiting = [...new Set(snapshot.approvals.map((approval) => approval.sessionId))].map(title)
  if (running.length === 0 && waiting.length === 0) return undefined
  const parts: string[] = []
  if (running.length) parts.push(`${running.length} ${running.length === 1 ? "turn is" : "turns are"} running (${running.join(", ")})`)
  if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? "gate is" : "gates are"} waiting (${waiting.join(", ")})`)
  return `${parts.join(" and ")}.`
}
