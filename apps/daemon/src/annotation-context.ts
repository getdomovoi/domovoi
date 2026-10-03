import type {
  ProviderPromptAnnotationDelivery,
  SessionSendReview,
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

// A review names comments and a preview by id. Each must still be what the
// person saw when they sent it: an open comment, or a preview, of this
// session. Anything else refuses the whole message rather than sending less
// than the person chose.
export class AnnotationReviewError extends Error {}

const unavailableCommentRefusal = "A comment sent with this message is not open on this session, so the message was not sent. Send it again without that comment."
const unavailableBuildBasisRefusal = "The build basis sent with this message is not a preview of this session, so the message was not sent."

export type BuildBasisContext = {
  artifactId: string
  artifactTitle: string
  artifactRevision: number
  variant?: { id: string, groupId: string, label: string }
}

// The comments and build basis one message sends (rulings Q348 A and Q342 A).
// When a message carries a review, nothing else reaches the agent: an open
// comment it does not name stays out of the turn.
export type AnnotationReview = {
  annotationIds: ReadonlySet<string>
  buildBasis?: BuildBasisContext
}

export const noAnnotationReview: AnnotationReview = { annotationIds: new Set() }

// LEGACY DEFAULT, ruling Q402. Until desktop, web, phone, tablet and the CLI
// send `review`, a message without one keeps the behaviour those clients were
// built against: every open comment of the session attaches, and no build
// basis. This is the only path that attaches a comment a message did not name.
// It is removed before protocol 0.8.0 ships (SHIP-PLAN.md, Preview and review);
// a message without a review then sends no comment.
export function legacyOpenCommentReview(snapshot: WorkspaceSnapshot, sessionId: string): AnnotationReview {
  return {
    annotationIds: new Set(snapshot.annotations
      .filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
      .map((annotation) => annotation.id)),
  }
}

export function resolveAnnotationReview(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  review: SessionSendReview | undefined,
): AnnotationReview {
  if (!review) return legacyOpenCommentReview(snapshot, sessionId)
  for (const annotationId of review.annotationIds) {
    const annotation = snapshot.annotations.find((candidate) => candidate.id === annotationId)
    if (!annotation || annotation.sessionId !== sessionId || annotation.status !== "open") {
      throw new AnnotationReviewError(unavailableCommentRefusal)
    }
  }
  let buildBasis: BuildBasisContext | undefined
  if (review.buildBasis) {
    const artifactId = review.buildBasis.artifactId
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === artifactId)
    if (!artifact || artifact.sessionId !== sessionId || artifact.type !== "preview") {
      throw new AnnotationReviewError(unavailableBuildBasisRefusal)
    }
    buildBasis = {
      artifactId: artifact.id,
      artifactTitle: truncate(artifact.title, 200),
      artifactRevision: artifact.revision,
      ...(artifact.variant
        ? { variant: { id: artifact.variant.id, groupId: artifact.variant.groupId, label: artifact.variant.label } }
        : {}),
    }
  }
  return {
    annotationIds: new Set(review.annotationIds),
    ...(buildBasis ? { buildBasis } : {}),
  }
}

function annotationReviewItems(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  annotationIds: ReadonlySet<string>,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
) {
  return snapshot.annotations
    .filter((annotation) => annotationIds.has(annotation.id) && annotation.sessionId === sessionId && annotation.status === "open")
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
  buildBasis: BuildBasisContext | undefined,
  userPrompt: string,
): string {
  const context = escapedJson({
    unresolvedAnnotations: annotations,
    omittedAnnotationCount,
    ...(buildBasis ? { buildBasis } : {}),
  })
  return [
    ...(annotations.length > 0
      ? ["The following structured Domovoi review context contains unresolved user annotations. Address relevant comments in this turn and preserve their annotation IDs when reporting what changed."]
      : []),
    ...(buildBasis
      ? ["The person chose the preview in buildBasis as the build basis. Build on that variant."]
      : []),
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
  buildBasis?: BuildBasisContext
}

export function prepareAnnotationContext(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  review: AnnotationReview,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
): PreparedAnnotationContext {
  const reviewItems = annotationReviewItems(snapshot, sessionId, review.annotationIds, visualDeliveries)
  return {
    availableCount: reviewItems.length,
    candidates: reviewItems.slice(0, maxAnnotations),
    omittedForLimit: Math.max(0, reviewItems.length - maxAnnotations),
    ...(review.buildBasis ? { buildBasis: review.buildBasis } : {}),
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
    // Not elastic: a message that chose a build basis always carries it.
    ...(prepared.buildBasis ? { buildBasis: { artifactId: prepared.buildBasis.artifactId } } : {}),
  }
  if (!annotations.length && !prepared.buildBasis) return { prompt: userPrompt, delivery }
  const omittedAnnotationCount = delivery.omitted.budget + delivery.omitted.limit
  return {
    prompt: annotationPrompt(annotations, omittedAnnotationCount, prepared.buildBasis, userPrompt),
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
  review: AnnotationReview,
  userPrompt: string,
  visualDeliveries: ReadonlyMap<string, "image-attached" | "provider-text-fallback" | "crop-unavailable"> = new Map(),
): string {
  const reviewItems = annotationReviewItems(snapshot, sessionId, review.annotationIds, visualDeliveries)

  if (!reviewItems.length && !review.buildBasis) return userPrompt
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
  return annotationPrompt(annotations, omittedAnnotationCount, review.buildBasis, userPrompt)
}
