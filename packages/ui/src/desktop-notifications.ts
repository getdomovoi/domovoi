import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

export type DesktopNotificationKind = "completion" | "failure" | "approval-needed"

export type DesktopNotificationRequest = {
  id: string
  kind: DesktopNotificationKind
  sessionId: string
}

function hash(value: string, seed: number): string {
  let current = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index)
    current = Math.imul(current, 0x01000193) >>> 0
  }
  return current.toString(16).padStart(8, "0")
}

function notificationId(kind: DesktopNotificationKind, source: string): string {
  const digest = `${hash(source, 0x811c9dc5)}${hash(source, 0x9e3779b9)}`
  return `desktop-${kind}-${digest}`
}

export class WorkspaceNotificationTracker {
  readonly #seen = new Set<string>()
  #previous: WorkspaceSnapshot | null = null

  observe(snapshot: WorkspaceSnapshot): DesktopNotificationRequest[] {
    const previous = this.#previous
    this.#previous = snapshot
    if (!previous) return []

    const notifications: DesktopNotificationRequest[] = []
    const priorSessions = new Map(previous.sessions.map((session) => [session.id, session]))
    for (const session of snapshot.sessions) {
      const prior = priorSessions.get(session.id)
      if (!prior || prior.state === session.state) continue
      const kind = session.state === "done"
        ? "completion"
        : session.state === "failed"
          ? "failure"
          : null
      if (!kind) continue
      const id = notificationId(kind, `${session.id}\0${session.updatedAt}`)
      if (this.#seen.has(id)) continue
      this.#seen.add(id)
      notifications.push({ id, kind, sessionId: session.id })
    }

    const priorApprovals = new Set(previous.approvals.map(({ id }) => id))
    for (const approval of snapshot.approvals) {
      if (priorApprovals.has(approval.id)) continue
      const kind = "approval-needed" as const
      const id = notificationId(kind, approval.id)
      if (this.#seen.has(id)) continue
      this.#seen.add(id)
      notifications.push({ id, kind, sessionId: approval.sessionId })
    }

    return notifications
  }
}
