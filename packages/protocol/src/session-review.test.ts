import { describe, expect, it } from "vitest"

import {
  annotationSchema,
  demoWorkspace,
  maximumReviewAnnotations,
  maximumReviewOverLimitCount,
  openCommentReviewFor,
  phoneAndTabletRpcMethods,
  providerPromptAnnotationDeliverySchema,
  rpcMethods,
  sessionSendParamsSchema,
  sessionReviewRefusalSchema,
  sessionSendReviewSchema,
  workspaceSnapshotSchema,
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

  // A full review can say how many more open comments the client left out for
  // the per-message limit, so the turn's record shows them as omitted rather
  // than losing them silently. It is a count, never a selection: the daemon
  // still sends only the comments the review names.
  describe("the count of open comments left over the per-message limit", () => {
    const full = Array.from({ length: maximumReviewAnnotations }, (_, index) => `annotation-${index}`)

    it("rides on a full review", () => {
      expect(sessionSendReviewSchema.parse({ annotationIds: full, omittedOverLimit: 1 })).toEqual({ annotationIds: full, omittedOverLimit: 1 })
      expect(sessionSendParamsSchema.parse({ ...send, review: { annotationIds: full, omittedOverLimit: 3 } }).review)
        .toEqual({ annotationIds: full, omittedOverLimit: 3 })
      expect(sessionSendReviewSchema.parse({ annotationIds: full, omittedOverLimit: maximumReviewOverLimitCount }).omittedOverLimit)
        .toBe(maximumReviewOverLimitCount)
    })

    it("is refused on a review with room left, since nothing was over the limit", () => {
      expect(sessionSendReviewSchema.safeParse({ annotationIds: full.slice(1), omittedOverLimit: 1 }).success).toBe(false)
      expect(sessionSendReviewSchema.safeParse({ annotationIds: [], omittedOverLimit: 1 }).success).toBe(false)
    })

    it("is a positive whole count within its bound, absent when nothing was left out", () => {
      for (const omittedOverLimit of [0, -1, 1.5, maximumReviewOverLimitCount + 1, "1"]) {
        expect(sessionSendReviewSchema.safeParse({ annotationIds: full, omittedOverLimit }).success).toBe(false)
      }
      expect(sessionSendReviewSchema.parse({ annotationIds: full })).not.toHaveProperty("omittedOverLimit")
    })
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
    expect(review.omittedOverLimit).toBe(3)
    expect(sessionSendReviewSchema.safeParse(review).success).toBe(true)
  })

  // Codex review of PR #717: with 21 open comments the oldest stayed open but
  // missed the turn, and nothing said so. The review now carries the count it
  // left out, which the daemon records as the turn's limit omission.
  it("counts the open comments it leaves out for the limit, and only those", () => {
    const comments = (count: number) => Array.from({ length: count }, (_, index) => annotation(
      `annotation-${index}`,
      { updatedAt: `2026-08-25T20:${String(index).padStart(2, "0")}:00.000Z` },
    ))
    const over = openCommentReviewFor({
      ...demoWorkspace,
      annotations: [
        ...comments(maximumReviewAnnotations + 1),
        annotation("annotation-resolved", { status: "resolved" }),
        annotation("annotation-elsewhere", { sessionId: "session-other" }),
      ],
    }, "session-billing")
    expect(over.annotationIds).toHaveLength(maximumReviewAnnotations)
    expect(over.annotationIds).not.toContain("annotation-0")
    expect(over.omittedOverLimit).toBe(1)
    expect(sessionSendParamsSchema.parse({ ...send, review: over }).review).toEqual(over)

    const exactly = openCommentReviewFor({ ...demoWorkspace, annotations: comments(maximumReviewAnnotations) }, "session-billing")
    expect(exactly.annotationIds).toHaveLength(maximumReviewAnnotations)
    expect(exactly).not.toHaveProperty("omittedOverLimit")
  })
})

// Review of PR #717: a send's review bounds each comment id at 256 UTF-16
// code units, so one open comment with a longer id made every send of its
// session invalid until it was resolved. Ruling Q432 A: the comment itself
// carries the same bound, so a longer id is refused where it enters, such as a
// transfer import, and the review for every open comment always fits the wire.
describe("a comment id, bounded like the review that names it", () => {
  const withId = (id: string) => ({ ...demoWorkspace.annotations[0]!, id })
  const snapshotWith = (id: string) => ({ ...demoWorkspace, annotations: [withId(id)] })

  it("is refused past 256 UTF-16 code units, alone and in a snapshot", () => {
    for (const id of ["a".repeat(257), "\u{1F600}".repeat(129)]) {
      expect(annotationSchema.safeParse(withId(id)).success).toBe(false)
      expect(workspaceSnapshotSchema.safeParse(snapshotWith(id)).success).toBe(false)
    }
  })

  it("is accepted at 256 UTF-16 code units, alone and in a snapshot", () => {
    for (const id of ["a".repeat(256), "\u{1F600}".repeat(128)]) {
      expect(annotationSchema.parse(withId(id)).id).toBe(id)
      expect(workspaceSnapshotSchema.parse(snapshotWith(id)).annotations[0]!.id).toBe(id)
    }
    expect(annotationSchema.safeParse(withId("")).success).toBe(false)
  })

  it("always yields a review the send accepts from a valid snapshot", () => {
    const longest = "a".repeat(256)
    const snapshot = workspaceSnapshotSchema.parse({
      ...demoWorkspace,
      annotations: [...demoWorkspace.annotations, withId(longest)],
    })
    const review = openCommentReviewFor(snapshot, "session-billing")
    expect(review.annotationIds).toContain(longest)
    expect(sessionSendReviewSchema.parse(review)).toEqual(review)
    expect(sessionSendParamsSchema.parse({ ...send, review }).review).toEqual(review)
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
