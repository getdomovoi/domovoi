import { maximumRenderedPreviewStages, performanceBudgets, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

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

export const maximumPreviewVariants = performanceBudgets.largePreviews.variantItems

// The build basis a send may carry: a preview of that session, which is what
// the daemon accepts (annotation-context.ts). A remembered id that no longer
// names one is dropped here, since sending it would refuse the whole message.
export function sessionPreviewBuildBasis(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  artifactId: string | undefined,
): Artifact | undefined {
  if (artifactId === undefined) return undefined
  return snapshot.artifacts.find((artifact) =>
    artifact.id === artifactId && artifact.sessionId === sessionId && artifact.type === "preview")
}

export type PreviewVariantWindow = {
  variants: Artifact[]
  // Where the window starts in the group's order, and how many the group holds.
  start: number
  total: number
  // The first variant of the page before and after this one, when there is one.
  previousPageArtifactId?: string | undefined
  nextPageArtifactId?: string | undefined
}

export function previewVariantsForActiveSession(
  snapshot: WorkspaceSnapshot,
  selectedArtifactId?: string,
): Artifact[] {
  return previewVariantWindowForActiveSession(snapshot, selectedArtifactId).variants
}

// A group over the budget is drawn a page of `maximumPreviewVariants` at a
// time, the page that holds the variant on screen, so every variant is one
// page turn away (#810 B5.3).
export function previewVariantWindowForActiveSession(
  snapshot: WorkspaceSnapshot,
  selectedArtifactId?: string,
): PreviewVariantWindow {
  const none: PreviewVariantWindow = { variants: [], start: 0, total: 0 }
  if (!snapshot.activeSessionId) return none
  const candidates = snapshot.artifacts.filter((artifact) =>
    artifact.sessionId === snapshot.activeSessionId
    && artifact.type === "preview"
    && artifact.mimeType === "text/html"
    && Boolean(artifact.path),
  )
  const anchor = candidates.find((artifact) => artifact.id === selectedArtifactId)
    ?? candidates.reduce<Artifact | undefined>((latest, artifact) =>
      !latest || artifact.revision >= latest.revision ? artifact : latest, undefined)
  if (!anchor) return none
  if (!anchor.variant) return { variants: [anchor], start: 0, total: 1 }
  const ordered = candidates
    .filter((artifact) => artifact.variant?.groupId === anchor.variant?.groupId)
    .sort((left, right) =>
      (left.variant?.order ?? 0) - (right.variant?.order ?? 0)
      || left.id.localeCompare(right.id),
    )
  const anchorIndex = Math.max(0, ordered.findIndex((artifact) => artifact.id === anchor.id))
  const start = anchorIndex - (anchorIndex % maximumPreviewVariants)
  const end = start + maximumPreviewVariants
  return {
    variants: ordered.slice(start, end),
    start,
    total: ordered.length,
    previousPageArtifactId: start > 0 ? ordered[start - maximumPreviewVariants]?.id : undefined,
    nextPageArtifactId: ordered[end]?.id,
  }
}

export function reviewLayoutFor(containerWidth: number, compareRequested: boolean, variantCount: number) {
  const availableStages = Math.min(maximumRenderedPreviewStages, variantCount)
  const compare = compareRequested && availableStages > 1 && containerWidth >= 760
  return { compare, stages: compare ? availableStages : 1 }
}

export function previewStagesForReview(
  variants: readonly Artifact[],
  selected: Artifact | undefined,
  stageCount: number,
): Artifact[] {
  if (!selected) return []
  return [selected, ...variants.filter((artifact) => artifact.id !== selected.id)]
    .slice(0, Math.max(1, Math.floor(stageCount)))
}

export function previewStageGridColumns(stageCount: number): string {
  return `repeat(${Math.max(1, Math.floor(stageCount))}, minmax(0, 1fr))`
}

export function previewToolbarLayoutFor(containerWidth: number): "wrap" | "inline" {
  return containerWidth < 720 ? "wrap" : "inline"
}

export function previewControlLayoutFor(containerWidth: number): { wrap: boolean; fullWidth: boolean } {
  const wrap = containerWidth < 720
  return { wrap, fullWidth: wrap }
}

export function previewStageObservationKey(previewId: string | undefined, previewError: string): string {
  return `${previewId ?? "none"}:${previewError ? "hidden" : "rendered"}`
}
