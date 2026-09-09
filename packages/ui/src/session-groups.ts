import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { StatusMeaning } from "./status-dot"

export type SessionGroupId = "running" | "needs-you" | "quiet"

export type GroupedSession = {
  id: string
  title: string
  meaning: StatusMeaning
  note: string
}

export type SessionGroup = {
  id: SessionGroupId
  label: string
  sessions: GroupedSession[]
}

// v2 replaces the flat sidebar with three groups. The rule follows the design:
// a session with a turn in flight is Running even when a gate is waiting on it,
// because the machine is still working; Needs you is for sessions where nothing
// is running and a person is the reason.
export function groupSessions(snapshot: WorkspaceSnapshot): SessionGroup[] {
  const gated = new Set(snapshot.approvals.map((approval) => approval.sessionId))
  const running: GroupedSession[] = []
  const needsYou: GroupedSession[] = []
  const quiet: GroupedSession[] = []

  for (const session of snapshot.sessions) {
    if (session.state === "archived") continue
    const waiting = gated.has(session.id)
    if (session.activeTurnId) {
      running.push({
        id: session.id,
        title: session.title,
        meaning: waiting ? "waiting" : "online",
        note: waiting ? "waiting on you" : "running",
      })
      continue
    }
    if (waiting) {
      needsYou.push({ id: session.id, title: session.title, meaning: "waiting", note: "waiting on you" })
      continue
    }
    if (session.state === "failed") {
      needsYou.push({ id: session.id, title: session.title, meaning: "offline", note: "failed" })
      continue
    }
    if (session.state === "ownership-conflict") {
      needsYou.push({ id: session.id, title: session.title, meaning: "offline", note: "ownership conflict" })
      continue
    }
    quiet.push({
      id: session.id,
      title: session.title,
      meaning: session.state === "transferred" ? "handoff" : "idle",
      // A transferred session lives on another machine now. Calling that idle
      // would hide where the work actually is.
      note: session.state === "transferred" ? "moved to another machine" : "idle",
    })
  }

  const groups: SessionGroup[] = [
    { id: "running", label: "RUNNING", sessions: running },
    { id: "needs-you", label: "NEEDS YOU", sessions: needsYou },
    { id: "quiet", label: "QUIET", sessions: quiet },
  ]
  return groups.filter((group) => group.sessions.length > 0)
}

export function sessionsNeedingYou(snapshot: WorkspaceSnapshot): number {
  return groupSessions(snapshot).find((group) => group.id === "needs-you")?.sessions.length ?? 0
}
