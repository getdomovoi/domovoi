import { describe, expect, it } from "vitest"

import {
  maximumReviewAnnotations,
  phoneAndTabletRpcMethods,
  providerPromptAnnotationDeliverySchema,
  rpcMethods,
  sessionSendParamsSchema,
  sessionReviewRefusalSchema,
  sessionSendReviewSchema,
} from "./index.js"

// Rulings Q348 A and Q342 A: preview comments reach the agent only when a
// person sends them, and the preview variant they chose travels with them.

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

  it("sends nothing when the message names no review, so no open comment rides along", () => {
    expect(sessionSendParamsSchema.parse(send)).not.toHaveProperty("review")
  })

  // An empty review is the explicit "send no comments": without it a client
  // could only omit review and fall into the Q402 legacy default.
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
