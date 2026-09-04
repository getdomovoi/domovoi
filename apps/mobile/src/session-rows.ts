import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

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

export function sessionRows(snapshot: WorkspaceSnapshot): SessionRow[] {
  // The snapshot carries only approvals still waiting on a person; decided ones
  // become receipts in the thread.
  const awaiting = new Set(snapshot.approvals.map((approval) => approval.sessionId))
  const previewable = new Set(
    snapshot.artifacts.filter((artifact) => artifact.type === "plan" || artifact.type === "preview")
      .map((artifact) => artifact.sessionId),
  )
  return snapshot.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    machine: snapshot.machine.name,
    runtime: `${session.runtime.provider}/${session.runtime.model}`,
    // Auto is part of the mode a person is deciding about, not a detail.
    mode: session.runtime.auto
      ? `${session.runtime.permissionMode} auto`
      : session.runtime.permissionMode,
    attention: awaiting.has(session.id)
      ? "approval"
      : previewable.has(session.id) ? "preview" : undefined,
    dot: session.state === "active"
      ? "active"
      : session.state === "waiting" ? "waiting" : "quiet",
  }))
}

export function waitingCount(snapshot: WorkspaceSnapshot): number {
  return new Set(snapshot.approvals.map((approval) => approval.sessionId)).size
}
