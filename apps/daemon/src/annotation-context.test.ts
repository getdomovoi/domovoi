import { describe, expect, it } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { agentPromptWithAnnotations } from "./annotation-context.js"

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
})
