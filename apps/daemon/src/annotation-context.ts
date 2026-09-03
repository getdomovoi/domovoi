import type {
  ProviderPromptAnnotationDelivery,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"

const contextBudget = 20_000
const maxAnnotations = 20

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function annotationReviewItems(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
) {
  return snapshot.annotations
    .filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((annotation) => {
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === annotation.artifactId)
      return {
        annotationId: annotation.id,
        artifactId: annotation.artifactId,
        artifactTitle: artifact?.title ?? annotation.artifactId,
        artifactType: artifact?.type ?? "unknown",
        artifactRevision: artifact?.revision,
        variantId: annotation.variantId,
        anchor: {
          ...(annotation.anchor.cssSelector
            ? { cssSelector: truncate(annotation.anchor.cssSelector, 1_000) }
            : {}),
          ...(annotation.anchor.textQuote
            ? { textQuote: truncate(annotation.anchor.textQuote, 1_000) }
            : {}),
          ...(annotation.anchor.bbox ? { bbox: annotation.anchor.bbox } : {}),
        },
        comment: { body: truncate(annotation.body, 2_000), origin: annotation.origin },
        ...(annotation.visualContext ? {
          visualContext: annotation.visualContext.status === "available"
            ? {
                status: annotation.visualContext.status,
                artifactRevision: annotation.visualContext.artifactRevision,
                mimeType: annotation.visualContext.mimeType,
                width: annotation.visualContext.width,
                height: annotation.visualContext.height,
                delivery: visualDeliveries.get(annotation.id) ?? "crop-unavailable",
              }
            : {
                ...annotation.visualContext,
                delivery: "crop-unavailable" as const,
              },
        } : {}),
        replies: annotation.thread.slice(-10).map((reply) => ({
          body: truncate(reply.body, 1_000),
          origin: reply.origin,
          createdAt: reply.createdAt,
        })),
      }
    })
}

type AnnotationReviewItem = ReturnType<typeof annotationReviewItems>[number]

function annotationPrompt(
  annotations: AnnotationReviewItem[],
  omittedAnnotationCount: number,
  userPrompt: string,
): string {
  const context = escapedJson({
    unresolvedAnnotations: annotations,
    omittedAnnotationCount,
  })
  return [
    "The following structured Domovoi review context contains unresolved user annotations. Address relevant comments in this turn and preserve their annotation IDs when reporting what changed.",
    "<domovoi_review_context>",
    context,
    "</domovoi_review_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n")
}

export type PreparedAnnotationContext = {
  availableCount: number
  candidates: AnnotationReviewItem[]
  omittedForLimit: number
}

export function prepareAnnotationContext(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
): PreparedAnnotationContext {
  const reviewItems = annotationReviewItems(snapshot, sessionId, visualDeliveries)
  return {
    availableCount: reviewItems.length,
    candidates: reviewItems.slice(0, maxAnnotations),
    omittedForLimit: Math.max(0, reviewItems.length - maxAnnotations),
  }
}

function renderAnnotationItems(
  prepared: PreparedAnnotationContext,
  annotations: AnnotationReviewItem[],
  userPrompt: string,
): { prompt: string; delivery: ProviderPromptAnnotationDelivery } {
  const delivery: ProviderPromptAnnotationDelivery = {
    availableCount: prepared.availableCount,
    deliveredIds: annotations.map((annotation) => annotation.annotationId),
    omitted: {
      budget: prepared.candidates.length - annotations.length,
      limit: prepared.omittedForLimit,
    },
  }
  if (!annotations.length) return { prompt: userPrompt, delivery }
  const omittedAnnotationCount = delivery.omitted.budget + delivery.omitted.limit
  return {
    prompt: annotationPrompt(annotations, omittedAnnotationCount, userPrompt),
    delivery,
  }
}

export function renderAnnotationContext(
  prepared: PreparedAnnotationContext,
  includedCount: number,
  userPrompt: string,
): { prompt: string; delivery: ProviderPromptAnnotationDelivery } {
  return renderAnnotationItems(
    prepared,
    prepared.candidates.slice(0, includedCount),
    userPrompt,
  )
}

export function agentPromptWithAnnotations(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
): string {
  const reviewItems = annotationReviewItems(snapshot, sessionId, visualDeliveries)

  if (!reviewItems.length) return userPrompt
  const annotations: AnnotationReviewItem[] = []
  let used = 0
  let omittedAnnotationCount = 0
  for (const item of reviewItems) {
    const size = escapedJson(item).length
    if (annotations.length >= maxAnnotations || used + size > contextBudget) {
      omittedAnnotationCount += 1
      continue
    }
    annotations.push(item)
    used += size
  }
  return annotationPrompt(annotations, omittedAnnotationCount, userPrompt)
}
