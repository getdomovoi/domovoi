import { boundedClientThread, type WorkspaceDelta, type WorkspaceSnapshot } from "@getdomovoi/protocol"

export function applyWorkspaceDelta(
  snapshot: WorkspaceSnapshot,
  delta: WorkspaceDelta,
): WorkspaceSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === delta.sessionId)
  if (!session) return snapshot
  let thread = snapshot.thread
  let artifacts = snapshot.artifacts

  for (const operation of delta.operations) {
    if (operation.kind === "assistant.append") {
      const existing = thread.find((item) => item.id === operation.id)
      thread = existing?.kind === "assistant"
        ? thread.map((item) => item.id === operation.id
            ? { ...existing, body: `${existing.body}${operation.delta}` }
            : item)
        : [...thread, {
            id: operation.id,
            sessionId: delta.sessionId,
            kind: "assistant",
            body: operation.delta,
            createdAt: operation.createdAt,
          }]
    }

    if (operation.kind === "tool-output.append") {
      const existing = thread.find((item) => item.id === operation.id)
      thread = existing?.kind === "tool"
        ? thread.map((item) => item.id === operation.id
            ? { ...existing, output: `${existing.output ?? ""}${operation.delta}` }
            : item)
        : [...thread, {
            id: operation.id,
            sessionId: delta.sessionId,
            kind: "tool",
            tool: "command",
            status: "running",
            title: "Command output",
            output: operation.delta,
            createdAt: operation.createdAt,
          }]
    }

    if (operation.kind === "plan.append") {
      const existing = artifacts.find((artifact) => artifact.id === operation.id)
      artifacts = existing?.type === "plan"
        ? artifacts.map((artifact) => artifact.id === operation.id
            ? {
                ...existing,
                content: `${existing.content ?? ""}${operation.delta}`,
                revision: operation.revision,
              }
            : artifact)
        : [...artifacts, {
            id: operation.id,
            sessionId: delta.sessionId,
            title: "Working plan",
            type: "plan",
            revision: operation.revision,
            mimeType: "text/markdown",
            content: operation.delta,
          }]
    }
  }

  return {
    ...snapshot,
    sessions: snapshot.sessions.map((candidate) => candidate.id === delta.sessionId
      ? { ...candidate, updatedAt: delta.updatedAt }
      : candidate),
    thread: boundedClientThread(thread, snapshot.activeSessionId),
    artifacts,
  }
}
