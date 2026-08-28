import type { WorkspaceDelta, WorkspaceSnapshot } from "@getdomovoi/protocol"

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  if (updates.length === 0) return current
  const replacements = new Map(updates.map((entity) => [entity.id, entity]))
  const existingIds = new Set(current.map((entity) => entity.id))
  return [
    ...current.map((entity) => replacements.get(entity.id) ?? entity),
    ...updates.filter((entity) => !existingIds.has(entity.id)),
  ]
}

export function applyWorkspaceDelta(
  snapshot: WorkspaceSnapshot,
  delta: WorkspaceDelta,
): WorkspaceSnapshot {
  if (!snapshot.sessions.some((session) => session.id === delta.session.id)) return snapshot
  const removedArtifactIds = new Set(delta.removedArtifactIds)
  return {
    ...snapshot,
    sessions: upsertById(snapshot.sessions, [delta.session]),
    thread: upsertById(snapshot.thread, delta.thread),
    artifacts: upsertById(
      snapshot.artifacts.filter((artifact) => !removedArtifactIds.has(artifact.id)),
      delta.artifacts,
    ),
    annotations: upsertById(snapshot.annotations, delta.annotations),
  }
}
