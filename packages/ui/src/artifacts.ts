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

export const maximumPreviewVariants = 24

export function previewVariantsForActiveSession(
  snapshot: WorkspaceSnapshot,
  selectedArtifactId?: string,
): Artifact[] {
  if (!snapshot.activeSessionId) return []
  const candidates = snapshot.artifacts.filter((artifact) =>
    artifact.sessionId === snapshot.activeSessionId
    && artifact.type === "preview"
    && artifact.mimeType === "text/html"
    && Boolean(artifact.path),
  )
  const anchor = candidates.find((artifact) => artifact.id === selectedArtifactId)
    ?? candidates.reduce<Artifact | undefined>((latest, artifact) =>
      !latest || artifact.revision >= latest.revision ? artifact : latest, undefined)
  if (!anchor) return []
  if (!anchor.variant) return [anchor]
  return candidates
    .filter((artifact) => artifact.variant?.groupId === anchor.variant?.groupId)
    .sort((left, right) =>
      (left.variant?.order ?? 0) - (right.variant?.order ?? 0)
      || left.id.localeCompare(right.id),
    )
    .slice(0, maximumPreviewVariants)
}

export function reviewLayoutFor(containerWidth: number, compareRequested: boolean, variantCount: number) {
  const compare = compareRequested && variantCount > 1 && containerWidth >= 760
  return { compare, stages: compare ? 2 : 1 }
}
