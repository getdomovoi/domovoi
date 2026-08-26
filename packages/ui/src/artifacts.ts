import type { Artifact, WorkspaceSnapshot } from "@getdomovoi/protocol"

export function latestArtifactForActiveSession(
  snapshot: WorkspaceSnapshot,
  type: Artifact["type"],
): Artifact | undefined {
  if (!snapshot.activeSessionId) return undefined
  return snapshot.artifacts.reduce<Artifact | undefined>((latest, artifact) => {
    if (artifact.sessionId !== snapshot.activeSessionId || artifact.type !== type) return latest
    return !latest || artifact.revision >= latest.revision ? artifact : latest
  }, undefined)
}
