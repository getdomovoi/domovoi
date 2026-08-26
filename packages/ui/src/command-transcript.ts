import type { ThreadItem, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type CommandTranscriptItem = Extract<ThreadItem, { kind: "tool" }> & {
  tool: "command"
}

export function commandTranscriptFor(snapshot: WorkspaceSnapshot): CommandTranscriptItem[] {
  if (!snapshot.activeSessionId) return []
  return snapshot.thread.filter(
    (item): item is CommandTranscriptItem =>
      item.sessionId === snapshot.activeSessionId &&
      item.kind === "tool" &&
      item.tool === "command",
  )
}
