import { describe, expect, it, vi } from "vitest"

import {
  demoWorkspace,
  maximumProviderPromptCodeUnits,
  type Annotation,
  type SkillDocument,
  type SkillEnablementReview,
  type SkillSummary,
  type WorkingPlan,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import {
  composeProviderPrompt,
  elasticPromptDropOrder,
} from "./prompt-composer.js"
import type { SkillCatalog } from "./skills.js"

const digest = `sha256:${"a".repeat(64)}` as const

function baseSnapshot(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.thread = []
  snapshot.annotations = []
  snapshot.workingPlans = []
  snapshot.skillEnablements = []
  return snapshot
}

function skillFixture(): {
  catalog: SkillCatalog
  review: SkillEnablementReview
  summary: SkillSummary
} {
  const summary: SkillSummary = {
    id: "skill-aaaaaaaaaaaa",
    name: "large-skill",
    description: "Large reviewed instructions",
    path: "/skills/large-skill/SKILL.md",
    scope: "user",
    source: "agents",
    manifest: { version: 1, capabilities: ["filesystem.read"] },
    contentDigest: digest,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  }
  const document: SkillDocument = { skill: summary, content: "s".repeat(12_000) }
  return {
    summary,
    review: {
      projectId: demoWorkspace.project!.id,
      skillId: summary.id,
      enabled: true,
      contentDigest: summary.contentDigest,
      manifest: summary.manifest,
      reviewedAt: "2026-09-03T12:00:00.000Z",
      reviewedBy: { client: "desktop", clientId: "desktop-primary" },
    },
    catalog: {
      list: vi.fn(async () => [summary]),
      read: vi.fn(async () => document),
    },
  }
}

function annotation(index: number): Annotation {
  return {
    ...structuredClone(demoWorkspace.annotations[0]!),
    id: `annotation-${index}`,
    body: `Review ${index} ${"a".repeat(2_000)}`,
    status: "open",
    updatedAt: new Date(Date.UTC(2026, 8, 3, 12, index)).toISOString(),
  }
}

function input(snapshot: WorkspaceSnapshot, userPrompt: string) {
  return {
    snapshot,
    sessionId: snapshot.sessions[0]!.id,
    userPrompt,
    capabilities: { vision: false },
    annotationVisualContext: {
      read: vi.fn(async () => new Uint8Array()),
    },
    skillCatalog: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => { throw new Error("missing") }),
    } satisfies SkillCatalog,
    requireTrustedSkills: false,
  }
}

describe("composeProviderPrompt budget", () => {
  it("encodes elastic retention separately from semantic prompt order", () => {
    expect(elasticPromptDropOrder).toEqual([
      "project-default-skills",
      "oldest-annotations",
    ])
  })

  it("drops project-default skills before annotations", async () => {
    const snapshot = baseSnapshot()
    const fixture = skillFixture()
    snapshot.annotations = [annotation(1)]
    snapshot.skillEnablements = [fixture.review]

    const result = await composeProviderPrompt({
      ...input(snapshot, "u".repeat(250_000)),
      skillCatalog: fixture.catalog,
    })

    expect(result.prompt.length).toBeLessThanOrEqual(maximumProviderPromptCodeUnits)
    expect(result.prompt).toContain("annotation-1")
    expect(result.prompt).not.toContain("large-skill")
    expect(result.prompt).toContain("<domovoi_context_delivery>")
    expect(result.prompt.slice(
      0,
      result.prompt.indexOf("</domovoi_context_delivery>")
        + "</domovoi_context_delivery>".length,
    )).toBe([
      "Domovoi omitted or shortened supporting session context before this turn. Treat the delivered context as incomplete; do not assume omitted items were absent from the session.",
      "<domovoi_context_delivery>",
      '{"skills":{"omitted":{"budget":1}}}',
      "</domovoi_context_delivery>",
    ].join("\n"))
    expect(result.providerPromptDelivery.skills.omitted.budget).toEqual([fixture.summary.id])
    expect(result.providerPromptDelivery.annotations.deliveredIds).toEqual(["annotation-1"])
    expect(result.providerPromptDelivery.budget.used).toBe(result.prompt.length)
  })

  it("drops oldest annotations only after default skills are gone", async () => {
    const snapshot = baseSnapshot()
    snapshot.annotations = Array.from({ length: 10 }, (_, index) => annotation(index))

    const result = await composeProviderPrompt(input(snapshot, "u".repeat(250_000)))

    expect(result.prompt.length).toBeLessThanOrEqual(maximumProviderPromptCodeUnits)
    expect(result.providerPromptDelivery.annotations.omitted.budget).toBeGreaterThan(0)
    expect(result.providerPromptDelivery.annotations.deliveredIds).toContain("annotation-9")
    expect(result.providerPromptDelivery.annotations.deliveredIds).not.toContain("annotation-0")
    expect(result.providerPromptDelivery.skills.omitted.budget).toEqual([])
  })

  it("does not attach visual context for annotations dropped from the prompt", async () => {
    const snapshot = baseSnapshot()
    snapshot.annotations = Array.from({ length: 6 }, (_, index) => ({
      ...annotation(index),
      visualContext: {
        status: "available" as const,
        ref: `crop-${index.toString(16).padStart(64, "0")}` as const,
        artifactRevision: 2,
        mimeType: "image/png" as const,
        width: 320,
        height: 56,
        byteLength: 4,
      },
    }))
    const read = vi.fn(async () => new Uint8Array([137, 80, 78, 71]))

    const result = await composeProviderPrompt({
      ...input(snapshot, "u".repeat(257_000)),
      capabilities: { vision: true },
      annotationVisualContext: { read },
    })

    expect(result.providerPromptDelivery.annotations.deliveredIds.length).toBeGreaterThan(0)
    expect(result.providerPromptDelivery.annotations.omitted.budget).toBeGreaterThan(0)
    expect(result.visualContexts.map((context) => context.annotationId)).toEqual(
      result.providerPromptDelivery.annotations.deliveredIds,
    )
    expect(read).toHaveBeenCalledTimes(4)
  })

  it("rejects a required plan instead of truncating canonical state", async () => {
    const snapshot = baseSnapshot()
    const plan: WorkingPlan = {
      sessionId: snapshot.sessions[0]!.id,
      revision: 1,
      structureRevision: 1,
      steps: Array.from({ length: 15 }, (_, index) => ({
        id: `step-${index}`,
        text: "p".repeat(4_000),
        status: "pending" as const,
      })),
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    }

    await expect(composeProviderPrompt({
      ...input(snapshot, "u".repeat(205_000)),
      workingPlan: plan,
    })).rejects.toThrow(
      "Cannot send this turn: required user request and working plan exceed the 262144 UTF-16 code units Domovoi payload limit. Shorten the request, edit the working plan and try again.",
    )
  })
})
