import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

type ToolItem = Extract<WorkspaceSnapshot["thread"][number], { kind: "tool" }>
export type CommandTranscript = ToolItem & { tool: "command" }

export function commandsForActiveSession(snapshot: WorkspaceSnapshot): CommandTranscript[] {
  if (!snapshot.activeSessionId) return []
  return snapshot.thread.filter(
    (item): item is CommandTranscript =>
      item.kind === "tool"
      && item.tool === "command"
      && item.sessionId === snapshot.activeSessionId,
  )
}
