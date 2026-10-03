import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  maximumReviewAnnotations,
  openCommentReviewFor,
  phoneAndTabletRpcMethods,
  providerPromptAnnotationDeliverySchema,
  rpcMethods,
  sessionSendParamsSchema,
  sessionReviewRefusalSchema,
  sessionSendReviewSchema,
  type WorkspaceSnapshot,
} from "./index.js"

// Rulings Q348 A and Q342 A: a message that carries a review sends only the
// comments it names, and the preview variant chosen travels with them. A
// message without one sends no comment and no build basis (ruling Q402: the
// legacy default that attached every open comment is gone).

const send = { sessionId: "session-billing", prompt: "Address these", client: "desktop" }

describe("the review a person sends with a message", () => {
  it("names the comments to send and the chosen build basis", () => {
    const review = { annotationIds: ["annotation-1", "annotation-2"], buildBasis: { artifactId: "artifact-preview-b" } }
    expect(sessionSendParamsSchema.parse({ ...send, review })).toEqual({ ...send, review })
    expect(sessionSendParamsSchema.parse({ ...send, review: { annotationIds: ["annotation-1"] } }).review)
      .toEqual({ annotationIds: ["annotation-1"] })
    // A chosen variant can travel without a comment.
    expect(sessionSendParamsSchema.parse({ ...send, review: { annotationIds: [], buildBasis: { artifactId: "artifact-preview-b" } } }).review)
      .toEqual({ annotationIds: [], buildBasis: { artifactId: "artifact-preview-b" } })
  })

  // Absent is read as none: the daemon never fills in a review the client did
  // not send, so no comment reaches the agent without being named.
  it("leaves review absent when the message carries none", () => {
    expect(sessionSendParamsSchema.parse(send)).not.toHaveProperty("review")
  })

  // An empty review is the explicit "send no comments", the same on the wire
  // as no review, and what a client sends when its surface attaches nothing.
  it("accepts an empty review as an explicit send of nothing", () => {
    expect(sessionSendReviewSchema.parse({ annotationIds: [] })).toEqual({ annotationIds: [] })
    expect(sessionSendParamsSchema.parse({ ...send, review: { annotationIds: [] } }).review).toEqual({ annotationIds: [] })
    expect(sessionSendReviewSchema.safeParse({}).success).toBe(false)
  })

  it("refuses a review that repeats a comment or names too many", () => {
    expect(sessionSendReviewSchema.safeParse({ annotationIds: ["annotation-1", "annotation-1"] }).success).toBe(false)
    const ids = Array.from({ length: maximumReviewAnnotations }, (_, index) => `annotation-${index}`)
    expect(sessionSendReviewSchema.parse({ annotationIds: ids }).annotationIds).toHaveLength(maximumReviewAnnotations)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: [...ids, "annotation-extra"] }).success).toBe(false)
    expect(maximumReviewAnnotations).toBe(20)
  })

  it("refuses identifiers that are empty or unbounded, and fields it does not describe", () => {
    expect(sessionSendReviewSchema.safeParse({ annotationIds: [""] }).success).toBe(false)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: ["a".repeat(257)] }).success).toBe(false)
    expect(sessionSendReviewSchema.parse({ annotationIds: ["a".repeat(256)] }).annotationIds).toHaveLength(1)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: [], buildBasis: { artifactId: "" } }).success).toBe(false)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: [], buildBasis: {} }).success).toBe(false)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: [], buildBasis: { artifactId: "a", variantId: "b" } }).success).toBe(false)
    expect(sessionSendReviewSchema.safeParse({ annotationIds: ["annotation-1"], all: true }).success).toBe(false)
    expect(sessionSendReviewSchema.safeParse({ buildBasis: { artifactId: "a" } }).success).toBe(false)
  })

  it("rides on session.send, so phone and tablet access is unchanged", () => {
    expect(rpcMethods["session.send"].params).toBe(sessionSendParamsSchema)
    expect(phoneAndTabletRpcMethods.has("session.send")).toBe(true)
    expect(Object.keys(rpcMethods).filter((method) => method.startsWith("annotation."))).toEqual([
      "annotation.create",
      "annotation.reply",
      "annotation.setStatus",
    ])
  })
})

// What a client sends while its surface offers no choice: every open comment
// of the session, which is what desktop, web and the phone show as open. The
// newest fill the per-message limit, the order the daemon delivered under the
// legacy default, so a client never asks for more than a message may carry.
describe("the review for every open comment of a session", () => {
  const annotation = (id: string, overrides: Partial<WorkspaceSnapshot["annotations"][number]> = {}) => ({
    ...demoWorkspace.annotations[0]!,
    id,
    thread: [],
    createdAt: "2026-08-25T20:00:00.000Z",
    updatedAt: "2026-08-25T20:00:00.000Z",
    ...overrides,
  })

  it("names the open comments of that session and nothing else", () => {
    const snapshot: WorkspaceSnapshot = {
      ...demoWorkspace,
      annotations: [
        ...demoWorkspace.annotations,
        annotation("annotation-resolved", { status: "resolved" }),
        annotation("annotation-elsewhere", { sessionId: "session-other" }),
      ],
    }
    expect(openCommentReviewFor(snapshot, "session-billing")).toEqual({
      annotationIds: ["annotation-migration-machine", "annotation-replay-copy"],
    })
    expect(sessionSendReviewSchema.parse(openCommentReviewFor(snapshot, "session-billing")))
      .toEqual(openCommentReviewFor(snapshot, "session-billing"))
    expect(openCommentReviewFor(snapshot, "session-billing")).not.toHaveProperty("buildBasis")
  })

  it("is the explicit send of nothing when the session has no open comment", () => {
    expect(openCommentReviewFor(demoWorkspace, "session-other")).toEqual({ annotationIds: [] })
    expect(openCommentReviewFor({ ...demoWorkspace, annotations: [] }, "session-billing")).toEqual({ annotationIds: [] })
  })

  it("keeps the newest comments up to the limit a message may carry", () => {
    const annotations = Array.from({ length: maximumReviewAnnotations + 3 }, (_, index) => annotation(
      `annotation-${index}`,
      { updatedAt: `2026-08-25T20:${String(index).padStart(2, "0")}:00.000Z` },
    ))
    const review = openCommentReviewFor({ ...demoWorkspace, annotations }, "session-billing")
    expect(review.annotationIds).toHaveLength(maximumReviewAnnotations)
    expect(review.annotationIds[0]).toBe(`annotation-${maximumReviewAnnotations + 2}`)
    expect(review.annotationIds).not.toContain("annotation-0")
    expect(review.annotationIds).not.toContain("annotation-2")
    expect(review.annotationIds).toContain("annotation-3")
    expect(sessionSendReviewSchema.safeParse(review).success).toBe(true)
  })
})

describe("a refused review", () => {
  it("names why in error data, and nothing else", () => {
    for (const reason of ["comment-unavailable", "build-basis-unavailable"]) {
      expect(sessionReviewRefusalSchema.parse({ kind: "session-review-refused", reason })).toEqual({ kind: "session-review-refused", reason })
    }
    expect(sessionReviewRefusalSchema.safeParse({ kind: "session-review-refused", reason: "invented" }).success).toBe(false)
    expect(sessionReviewRefusalSchema.safeParse({ kind: "session-review-refused", reason: "comment-unavailable", annotationId: "a" }).success).toBe(false)
  })
})

describe("the record of what a turn delivered", () => {
  const delivered = { availableCount: 1, deliveredIds: ["annotation-1"], omitted: { budget: 0, limit: 0 } }

  it("names the build basis the agent was given", () => {
    const withBasis = { ...delivered, buildBasis: { artifactId: "artifact-preview-b" } }
    expect(providerPromptAnnotationDeliverySchema.parse(withBasis)).toEqual(withBasis)
    expect(providerPromptAnnotationDeliverySchema.parse(delivered)).not.toHaveProperty("buildBasis")
    expect(providerPromptAnnotationDeliverySchema.safeParse({ ...delivered, buildBasis: { artifactId: "" } }).success).toBe(false)
    expect(providerPromptAnnotationDeliverySchema.safeParse({ ...delivered, buildBasis: { artifactId: "a", title: "B" } }).success).toBe(false)
  })
})
