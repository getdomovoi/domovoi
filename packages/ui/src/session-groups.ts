import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { StatusMeaning } from "./status-dot"

export type SessionGroupId = "running" | "needs-you" | "quiet"

export type GroupedSession = {
  id: string
  title: string
  meaning: StatusMeaning
  note: string
  // What the row's menu may offer: Stop only while a turn runs, and nothing
  // that changes a session already on its way out.
  running: boolean
  archiving: boolean
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
    const flags = { running: Boolean(session.activeTurnId), archiving: session.state === "archiving" }
    if (session.activeTurnId) {
      running.push({
        id: session.id,
        title: session.title,
        meaning: waiting ? "waiting" : "online",
        note: waiting ? "waiting on you" : "running",
        ...flags,
      })
      continue
    }
    if (waiting) {
      needsYou.push({ id: session.id, title: session.title, meaning: "waiting", note: "waiting on you", ...flags })
      continue
    }
    if (session.state === "failed") {
      needsYou.push({ id: session.id, title: session.title, meaning: "offline", note: "failed", ...flags })
      continue
    }
    if (session.state === "ownership-conflict") {
      needsYou.push({ id: session.id, title: session.title, meaning: "offline", note: "ownership conflict", ...flags })
      continue
    }
    quiet.push({
      id: session.id,
      title: session.title,
      // The dot shows a state and the note shows the event. A moved session is
      // quiet here; where the work went is what the note is for, and colour is
      // not asked to carry a thing that happened.
      meaning: "idle",
      note: session.state === "transferred" ? "moved to another machine" : session.state === "archiving" ? "archiving" : "idle",
      ...flags,
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
