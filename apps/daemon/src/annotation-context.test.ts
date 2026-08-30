import { describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { agentPromptWithAnnotations } from "./annotation-context.js"
import { prepareAnnotationTurn } from "./annotation-visual-turn.js"

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
})
