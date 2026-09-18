import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { fleetSummary } from "./machine-rows"

export type SessionRow = {
  id: string
  title: string
  machine: string
  runtime: string
  mode: string
  // What the session wants from the person, if anything. The phone is for
  // acting rather than watching, so this decides how the row reads.
  attention: "approval" | "preview" | undefined
  dot: "active" | "waiting" | "quiet"
}

// How long something has been waiting, in the shortest form that is still true.
// A clock that disagrees with the daemon's can put a timestamp in the future,
// and a negative age would be a smaller lie than "now" but a stranger one.
export function elapsedLabel(iso: string, now: number): string | undefined {
  const started = Date.parse(iso)
  if (Number.isNaN(started)) return undefined
  const seconds = Math.floor((now - started) / 1_000)
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export type ApprovalLead = {
  approvalId: string
  headline: string
  command: string
  context: string
  // Absent when the daemon sent a timestamp this phone cannot read. An age is
  // worth showing but not worth inventing.
  waited: string | undefined
}

// The one thing a person opening this app at a traffic light needs to see
// without scrolling. When several approvals are waiting, the one that has been
// waiting longest is the one shown, because it is the one closest to blocking
// everything behind it.
export function approvalLead(
  snapshot: WorkspaceSnapshot,
  now: number,
): ApprovalLead | undefined {
  const oldest = [...snapshot.approvals]
    .sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt))[0]
  if (!oldest) return undefined
  const count = snapshot.approvals.length
  const title = snapshot.sessions.find((session) => session.id === oldest.sessionId)?.title
  return {
    approvalId: oldest.id,
    headline: `${count} approval${count === 1 ? "" : "s"} waiting`,
    command: oldest.command,
    context: title ? `${oldest.machine} · ${title}` : oldest.machine,
    waited: elapsedLabel(oldest.requestedAt, now),
  }
}

// Lower sorts first. The phone is for acting, so the order is how much each
// session wants from the person, not when the daemon happened to list it.
const attentionRank: Record<"approval" | "preview" | "none", number> = {
  approval: 0,
  preview: 1,
  none: 2,
}

export function sessionRows(snapshot: WorkspaceSnapshot): SessionRow[] {
  // The snapshot carries only approvals still waiting on a person; decided ones
  // become receipts in the thread.
  const awaiting = new Map(
    snapshot.approvals.map((approval) => [approval.sessionId, approval.requestedAt]),
  )
  const previewable = new Set(
    snapshot.artifacts.filter((artifact) => artifact.type === "plan" || artifact.type === "preview")
      .map((artifact) => artifact.sessionId),
  )
  return snapshot.sessions
    .map((session) => {
      const attention = awaiting.has(session.id)
        ? "approval" as const
        : previewable.has(session.id) ? "preview" as const : undefined
      return {
        session,
        attention,
        row: {
          id: session.id,
          title: session.title,
          machine: snapshot.machine.name,
          runtime: `${session.runtime.provider}/${session.runtime.model}`,
          // Auto is part of the mode a person is deciding about, not a detail.
          mode: session.runtime.auto
            ? `${session.runtime.permissionMode} auto`
            : session.runtime.permissionMode,
          attention,
          dot: session.state === "active"
            ? "active" as const
            : session.state === "waiting" ? "waiting" as const : "quiet" as const,
        },
      }
    })
    .sort((left, right) => {
      const rank = attentionRank[left.attention ?? "none"] - attentionRank[right.attention ?? "none"]
      if (rank !== 0) return rank
      // Among sessions holding an approval, the one waiting longest goes first.
      if (left.attention === "approval") {
        const waited = Date.parse(awaiting.get(left.session.id) ?? "")
          - Date.parse(awaiting.get(right.session.id) ?? "")
        if (!Number.isNaN(waited) && waited !== 0) return waited
      }
      // Otherwise the most recently touched, which is the closest honest stand
      // in for what the person was last involved with.
      return Date.parse(right.session.updatedAt) - Date.parse(left.session.updatedAt)
    })
    .map((entry) => entry.row)
}

export type SessionGroupId = "needs-you" | "running" | "quiet"

export type SessionGroup = {
  id: SessionGroupId
  label: string
  rows: SessionRow[]
}

// The design draws the list as three groups, needs-you first and never
// collapsed. A session holding an approval is needs-you even while its turn
// runs: on a phone the person is the reason to open the app, so what wants
// them outranks what the machine is doing. Order inside a group is the row
// order, so the longest-waiting approval still leads its group.
export function sessionGroups(snapshot: WorkspaceSnapshot): SessionGroup[] {
  const groups: SessionGroup[] = [
    { id: "needs-you", label: "NEEDS YOU", rows: [] },
    { id: "running", label: "RUNNING", rows: [] },
    { id: "quiet", label: "QUIET", rows: [] },
  ]
  for (const row of sessionRows(snapshot)) {
    const target = row.attention === "approval" ? 0 : row.dot === "active" ? 1 : 2
    groups[target]!.rows.push(row)
  }
  return groups.filter((group) => group.rows.length > 0)
}

export function waitingCount(snapshot: WorkspaceSnapshot): number {
  return new Set(snapshot.approvals.map((approval) => approval.sessionId)).size
}

// The line under the Sessions title. The sessions are one machine's, so the
// running count is scoped to that machine by name; the handoff says "none
// running" rather than "0 running" because a zero reads as a measurement that
// failed. The fleet part says how many machines answered and how many did
// not, in the fleet screen's own words. It never says "3 machines": that
// would state a fact about three machines from the data of one, and no results
// and not searched are different answers.
export function sessionsHeaderLine(snapshot: WorkspaceSnapshot, fleet: FleetEntry[] | undefined): string {
  const running = snapshot.sessions.filter((session) => session.state === "active").length
  const runningLabel = running === 0 ? "none running" : `${running} running`
  const summary = fleet ? fleetSummary(fleet) : undefined
  return [snapshot.machine.name, runningLabel, summary].filter((part) => part !== undefined).join(" · ")
}
