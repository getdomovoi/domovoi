import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

// The tablet always shows a thread when one exists. Its project context must
// follow that same fallback when the selected session disappears.
export function tabletSessionId(snapshot: WorkspaceSnapshot, selectedSessionId?: string): string | undefined {
  return selectedSessionId && snapshot.sessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : snapshot.activeSessionId ?? snapshot.sessions[0]?.id
}
