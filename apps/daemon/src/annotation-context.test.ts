import { describe, expect, it, vi } from "vitest"

import { demoWorkspace, type Annotation } from "@getdomovoi/protocol"

import { agentPromptWithAnnotations } from "./annotation-context.js"
import { prepareAnnotationTurn } from "./annotation-visual-turn.js"

function availableAnnotation(options: {
  id: string
  sequence: number
  updatedAt: string
  byteLength?: number
  sessionId?: string
  status?: Annotation["status"]
}): Annotation {
  return {
    ...structuredClone(demoWorkspace.annotations[1]!),
    id: options.id,
    sessionId: options.sessionId ?? "session-billing",
    status: options.status ?? "open",
    createdAt: options.updatedAt,
    updatedAt: options.updatedAt,
    visualContext: {
      status: "available",
      ref: `crop-${options.sequence.toString(16).padStart(64, "0")}`,
      artifactRevision: 2,
      mimeType: "image/png",
      width: 320,
      height: 56,
      byteLength: options.byteLength ?? 4,
    },
  }
}

function availableCrop(annotation: Annotation): Extract<
  NonNullable<Annotation["visualContext"]>,
  { status: "available" }
> {
  if (annotation.visualContext?.status !== "available") {
    throw new Error("Expected available visual context")
  }
  return annotation.visualContext
}

function unresolvedAnnotations(prompt: string): Array<{
  annotationId: string
  visualContext?: { delivery?: string }
}> {
  const match = /<domovoi_review_context>\n(.+)\n<\/domovoi_review_context>/.exec(prompt)
  if (!match) throw new Error("Missing structured review context")
  return (JSON.parse(match[1]!) as {
    unresolvedAnnotations: Array<{
      annotationId: string
      visualContext?: { delivery?: string }
    }>
  }).unresolvedAnnotations
}

describe("agentPromptWithAnnotations", () => {
  it("adds unresolved session annotations as structured review context", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.annotations[0]!.body = "Keep <review> staging-only."
    snapshot.annotations[1]!.status = "resolved"

    const prompt = agentPromptWithAnnotations(snapshot, "session-billing", "Revise the plan.")

    expect(prompt).toContain("<domovoi_review_context>")
    expect(prompt).toContain('"annotationId":"annotation-migration-machine"')
    expect(prompt).toContain('"artifactTitle":"Idempotent webhook migration"')
    expect(prompt).toContain("Keep \\u003creview> staging-only.")
    expect(prompt).toContain("I will revise step three before continuing.")
    expect(prompt).not.toContain("annotation-replay-copy")
    expect(prompt).toContain("<user_request>\nRevise the plan.\n</user_request>")
  })

  it("leaves the user prompt unchanged without unresolved annotations", () => {
    expect(agentPromptWithAnnotations(demoWorkspace, "session-onboarding", "Continue.")).toBe(
      "Continue.",
    )
  })

  it("bounds annotation context before sending it to a provider", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.annotations = Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(snapshot.annotations[0]!),
      id: `annotation-${index}`,
      body: `Comment ${index} ${"<".repeat(4_000)}`,
      updatedAt: new Date(Date.UTC(2026, 7, 25, 22, index)).toISOString(),
    }))

    const prompt = agentPromptWithAnnotations(snapshot, "session-billing", "Continue.")

    expect(prompt.length).toBeLessThan(25_000)
    expect(prompt).toContain('"omittedAnnotationCount":')
    expect(prompt).toContain('"annotationId":"annotation-29"')
  })

  it("attaches crop bytes only for declared vision capability", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.annotations[1]!.visualContext = {
      status: "available",
      ref: `crop-${"a".repeat(64)}`,
      artifactRevision: 2,
      mimeType: "image/png",
      width: 320,
      height: 56,
      byteLength: 4,
    }
    const read = vi.fn(async () => new Uint8Array([137, 80, 78, 71]))

    const vision = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: true },
      { read },
    )
    expect(vision.visualContexts).toEqual([expect.objectContaining({
      annotationId: "annotation-replay-copy",
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    })])
    expect(vision.prompt).toContain('"delivery":"image-attached"')

    const textOnly = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: false },
      { read },
    )
    expect(textOnly.visualContexts).toEqual([])
    expect(textOnly.prompt).toContain('"delivery":"provider-text-fallback"')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(`crop-${"a".repeat(64)}`, "image/png")
    expect(textOnly.prompt).not.toContain("iVBOR")
  })

  it("attaches at most four crops in newest-first order", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const annotations = Array.from({ length: 6 }, (_, index) => availableAnnotation({
      id: `annotation-${index + 1}`,
      sequence: index + 1,
      updatedAt: new Date(Date.UTC(2026, 7, 25, 21, index)).toISOString(),
    }))
    snapshot.annotations = [annotations[2]!, annotations[5]!, annotations[0]!, annotations[4]!, annotations[1]!, annotations[3]!]
    const read = vi.fn(async (
      _ref: string,
      _expectedMimeType: "image/png" | "image/jpeg" | "image/webp",
    ) => new Uint8Array([137, 80, 78, 71]))

    const prepared = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: true },
      { read },
    )

    expect(prepared.visualContexts.map((context) => context.annotationId)).toEqual([
      "annotation-6",
      "annotation-5",
      "annotation-4",
      "annotation-3",
    ])
    expect(read.mock.calls.map(([ref]) => ref)).toEqual([
      availableCrop(annotations[5]!).ref,
      availableCrop(annotations[4]!).ref,
      availableCrop(annotations[3]!).ref,
      availableCrop(annotations[2]!).ref,
    ])
    expect(unresolvedAnnotations(prepared.prompt).map((annotation) => ({
      id: annotation.annotationId,
      delivery: annotation.visualContext?.delivery,
    }))).toEqual([
      { id: "annotation-6", delivery: "image-attached" },
      { id: "annotation-5", delivery: "image-attached" },
      { id: "annotation-4", delivery: "image-attached" },
      { id: "annotation-3", delivery: "image-attached" },
      { id: "annotation-2", delivery: "crop-unavailable" },
      { id: "annotation-1", delivery: "crop-unavailable" },
    ])
  })

  it("keeps attached crop bytes within the cumulative turn ceiling", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const first = availableAnnotation({
      id: "annotation-first",
      sequence: 1,
      updatedAt: "2026-08-25T21:54:00.000Z",
      byteLength: 1_500_000,
    })
    const second = availableAnnotation({
      id: "annotation-second",
      sequence: 2,
      updatedAt: "2026-08-25T21:53:00.000Z",
      byteLength: 1_500_000,
    })
    const overBudget = availableAnnotation({
      id: "annotation-over-budget",
      sequence: 3,
      updatedAt: "2026-08-25T21:52:00.000Z",
      byteLength: 1_000_001,
    })
    const exactLimit = availableAnnotation({
      id: "annotation-exact-limit",
      sequence: 4,
      updatedAt: "2026-08-25T21:51:00.000Z",
      byteLength: 1_000_000,
    })
    snapshot.annotations = [exactLimit, overBudget, first, second]
    const byteLengths = new Map(snapshot.annotations.map((annotation) => [
      availableCrop(annotation).ref,
      availableCrop(annotation).byteLength,
    ]))
    const read = vi.fn(async (ref: string) => new Uint8Array(byteLengths.get(ref) || 0))

    const prepared = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: true },
      { read },
    )

    expect(prepared.visualContexts.map((context) => context.annotationId)).toEqual([
      "annotation-first",
      "annotation-second",
      "annotation-exact-limit",
    ])
    expect(prepared.visualContexts.reduce((total, context) => total + context.bytes.byteLength, 0))
      .toBe(4_000_000)
    expect(read).not.toHaveBeenCalledWith(
      availableCrop(overBudget).ref,
      "image/png",
    )
    expect(unresolvedAnnotations(prepared.prompt)).toContainEqual(expect.objectContaining({
      annotationId: "annotation-over-budget",
      visualContext: expect.objectContaining({ delivery: "crop-unavailable" }),
    }))
  })

  it("keeps unreadable and length-mismatched crops as unavailable prompt context", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const rejected = availableAnnotation({
      id: "annotation-rejected",
      sequence: 1,
      updatedAt: "2026-08-25T21:53:00.000Z",
    })
    const mismatched = availableAnnotation({
      id: "annotation-mismatched",
      sequence: 2,
      updatedAt: "2026-08-25T21:52:00.000Z",
    })
    const attached = availableAnnotation({
      id: "annotation-attached",
      sequence: 3,
      updatedAt: "2026-08-25T21:51:00.000Z",
    })
    snapshot.annotations = [attached, rejected, mismatched]
    const read = vi.fn(async (ref: string) => {
      if (ref === availableCrop(rejected).ref) {
        throw new Error("crop disappeared")
      }
      if (ref === availableCrop(mismatched).ref) {
        return new Uint8Array([137, 80, 78])
      }
      return new Uint8Array([137, 80, 78, 71])
    })

    const prepared = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: true },
      { read },
    )

    expect(prepared.visualContexts.map((context) => context.annotationId)).toEqual([
      "annotation-attached",
    ])
    expect(unresolvedAnnotations(prepared.prompt)).toEqual([
      expect.objectContaining({
        annotationId: "annotation-rejected",
        visualContext: expect.objectContaining({ delivery: "crop-unavailable" }),
      }),
      expect.objectContaining({
        annotationId: "annotation-mismatched",
        visualContext: expect.objectContaining({ delivery: "crop-unavailable" }),
      }),
      expect.objectContaining({
        annotationId: "annotation-attached",
        visualContext: expect.objectContaining({ delivery: "image-attached" }),
      }),
    ])
  })

  it("excludes closed and non-current-session annotations", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const current = availableAnnotation({
      id: "annotation-current",
      sequence: 1,
      updatedAt: "2026-08-25T21:51:00.000Z",
    })
    const closed = availableAnnotation({
      id: "annotation-closed",
      sequence: 2,
      updatedAt: "2026-08-25T21:53:00.000Z",
      status: "resolved",
    })
    const anotherSession = availableAnnotation({
      id: "annotation-another-session",
      sequence: 3,
      updatedAt: "2026-08-25T21:52:00.000Z",
      sessionId: "session-onboarding",
    })
    snapshot.annotations = [closed, anotherSession, current]
    const read = vi.fn(async () => new Uint8Array([137, 80, 78, 71]))

    const prepared = await prepareAnnotationTurn(
      snapshot,
      "session-billing",
      "Revise.",
      { vision: true },
      { read },
    )

    expect(prepared.visualContexts.map((context) => context.annotationId)).toEqual([
      "annotation-current",
    ])
    expect(read).toHaveBeenCalledOnce()
    expect(unresolvedAnnotations(prepared.prompt).map((annotation) => annotation.annotationId))
      .toEqual(["annotation-current"])
    expect(prepared.prompt).not.toContain("annotation-closed")
    expect(prepared.prompt).not.toContain("annotation-another-session")
  })
})
