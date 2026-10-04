import { maximumReviewAnnotations, type SessionSendReview } from "./prompt-delivery.js"
import type { WorkspaceSnapshot } from "./schema.js"

/**
 * The review a client sends while its surface offers no choice of comments:
 * every open comment of the session, which is what desktop, web and the phone
 * list as open. The daemon attaches only what a message names (ruling Q402),
 * so a client that showed the person open comments names them here rather
 * than leaving them behind.
 *
 * A message carries at most `maximumReviewAnnotations`; the newest fill it, in
 * the order the daemon delivered them before the review existed. The older
 * ones left out are counted in `omittedOverLimit`, which the daemon records as
 * the turn's limit omission, so they do not miss the turn unseen. No build
 * basis: the chosen preview travels only when a surface sends it on purpose
 * (ruling Q342 A).
 */
export function openCommentReviewFor(snapshot: WorkspaceSnapshot, sessionId: string): SessionSendReview {
  const open = snapshot.annotations
    .filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const omittedOverLimit = open.length - maximumReviewAnnotations
  return {
    annotationIds: open.slice(0, maximumReviewAnnotations).map((annotation) => annotation.id),
    ...(omittedOverLimit > 0 ? { omittedOverLimit } : {}),
  }
}
