import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

const contextBudget = 20_000
const maxAnnotations = 20

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

export function agentPromptWithAnnotations(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
): string {
  const reviewItems = snapshot.annotations
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
        replies: annotation.thread.slice(-10).map((reply) => ({
          body: truncate(reply.body, 1_000),
          origin: reply.origin,
          createdAt: reply.createdAt,
        })),
      }
    })

  if (!reviewItems.length) return userPrompt
  const annotations: typeof reviewItems = []
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
