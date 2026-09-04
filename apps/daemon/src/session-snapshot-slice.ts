import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

type SnapshotTransferPolicy = "session-slice" | "preserve"

// A transfer owns one session and its dependent records. Project authority and
// client selection stay local. Keeping this exhaustive turns a new workspace
// field into a compile error until its transfer ownership is decided.
export const sessionSnapshotTransferPolicy = {
  protocolVersion: "preserve",
  machine: "preserve",
  project: "preserve",
  sessions: "session-slice",
  activeSessionId: "preserve",
  approvals: "session-slice",
  approvalRules: "preserve",
  thread: "session-slice",
  artifacts: "session-slice",
  workingPlans: "session-slice",
  annotations: "session-slice",
  skillEnablements: "preserve",
  historyTruncated: "preserve",
} as const satisfies Record<keyof WorkspaceSnapshot, SnapshotTransferPolicy>

function mergeKeyedSessionRecords<T>(
  latest: readonly T[],
  candidate: readonly T[],
  belongsToSession: (record: T) => boolean,
  keyOf: (record: T) => string,
): T[] {
  const replacements = new Map(
    candidate.filter(belongsToSession).map((record) => [keyOf(record), record]),
  )
  const applied = new Set<string>()
  const merged = latest.flatMap((record) => {
    if (!belongsToSession(record)) return [record]
    const key = keyOf(record)
    const replacement = replacements.get(key)
    if (!replacement) return []
    applied.add(key)
    return [replacement]
  })
  for (const [key, record] of replacements) {
    if (!applied.has(key)) merged.push(record)
  }
  return merged
}

export function mergeSessionSnapshotSlice(
  latest: WorkspaceSnapshot,
  candidate: WorkspaceSnapshot,
  sessionId: string,
): WorkspaceSnapshot {
  const bySessionId = <T extends { sessionId: string }>(record: T) => (
    record.sessionId === sessionId
  )
  const byId = <T extends { id: string }>(record: T) => record.id

  return {
    ...latest,
    sessions: mergeKeyedSessionRecords(
      latest.sessions,
      candidate.sessions,
      (session) => session.id === sessionId,
      byId,
    ),
    approvals: mergeKeyedSessionRecords(
      latest.approvals,
      candidate.approvals,
      bySessionId,
      byId,
    ),
    thread: mergeKeyedSessionRecords(
      latest.thread,
      candidate.thread,
      bySessionId,
      byId,
    ),
    artifacts: mergeKeyedSessionRecords(
      latest.artifacts,
      candidate.artifacts,
      bySessionId,
      byId,
    ),
    workingPlans: mergeKeyedSessionRecords(
      latest.workingPlans,
      candidate.workingPlans,
      bySessionId,
      (plan) => plan.sessionId,
    ),
    annotations: mergeKeyedSessionRecords(
      latest.annotations,
      candidate.annotations,
      bySessionId,
      byId,
    ),
  }
}
