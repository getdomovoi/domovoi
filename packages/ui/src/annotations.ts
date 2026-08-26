import type { Annotation, WorkspaceSnapshot } from "@getdomovoi/protocol"

export function annotationsForActiveSession(snapshot: WorkspaceSnapshot): Annotation[] {
  if (!snapshot.activeSessionId) return []
  return snapshot.annotations.filter(
    (annotation) => annotation.sessionId === snapshot.activeSessionId,
  )
}
