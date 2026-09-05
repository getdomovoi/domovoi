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
  providerPromptPrecedence,
  validateProviderPromptBudget,
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

function skillFixture(overrides: { id?: string; name?: string; content?: string } = {}): {
  catalog: SkillCatalog
  document: SkillDocument
  review: SkillEnablementReview
  summary: SkillSummary
} {
  const name = overrides.name ?? "large-skill"
  const summary: SkillSummary = {
    id: overrides.id ?? "skill-aaaaaaaaaaaa",
    name,
    description: "Large reviewed instructions",
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    source: "agents",
    manifest: { version: 1, capabilities: ["filesystem.read"] },
    contentDigest: digest,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  }
  const document: SkillDocument = {
    skill: summary,
    content: overrides.content ?? "s".repeat(12_000),
  }
  return {
    summary,
    document,
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
    expect(providerPromptPrecedence).toEqual([
      "skills",
      "annotations",
      "working-plan",
      "provider-handoff",
      "user-request",
    ])
    expect(elasticPromptDropOrder).toEqual([
      "skills",
      "annotations",
      "handoff-history",
      "handoff-annotations",
      "handoff-artifacts",
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

  it("rejects overflow instead of dropping an explicitly selected skill", async () => {
    const snapshot = baseSnapshot()
    const fixture = skillFixture()
    snapshot.skillEnablements = [fixture.review]

    await expect(composeProviderPrompt({
      ...input(snapshot, "u".repeat(250_000)),
      skillCatalog: fixture.catalog,
      skillSelection: {
        mode: "turn-explicit",
        skills: [{
          skillId: fixture.summary.id,
          review: {
            contentDigest: fixture.review.contentDigest,
            manifest: fixture.review.manifest,
          },
        }],
      },
    })).rejects.toThrow(
      "Cannot send this turn: required user request and explicitly selected skills exceed the 262144 UTF-16 code units Domovoi payload limit. Shorten the request, remove one or more selected skills and try again.",
    )
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

describe("composeProviderPrompt budget option", () => {
  it("keeps a prompt under the configured budget untouched", async () => {
    const snapshot = baseSnapshot()
    const fixture = skillFixture()
    snapshot.annotations = [annotation(1)]
    snapshot.skillEnablements = [fixture.review]
    const request = { ...input(snapshot, "Ship it"), skillCatalog: fixture.catalog }

    const unbounded = await composeProviderPrompt(request)
    const bounded = await composeProviderPrompt({
      ...request,
      budgetCodeUnits: unbounded.prompt.length,
    })

    expect(bounded.prompt).toBe(unbounded.prompt)
    expect(bounded.providerPromptDelivery).toEqual({
      ...unbounded.providerPromptDelivery,
      budget: {
        unit: "utf16-code-units",
        limit: unbounded.prompt.length,
        used: unbounded.prompt.length,
      },
    })
    expect(bounded.providerPromptDelivery.skills.omitted.budget).toEqual([])
    expect(bounded.providerPromptDelivery.annotations.omitted.budget).toBe(0)
  })

  it("refuses a budget smaller than the user request instead of trimming it", async () => {
    await expect(composeProviderPrompt({
      ...input(baseSnapshot(), "u".repeat(200)),
      budgetCodeUnits: 100,
    })).rejects.toThrow(
      "Cannot send this turn: required user request exceed the 100 UTF-16 code units Domovoi payload limit. Shorten the request and try again.",
    )
  })

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maximumProviderPromptCodeUnits + 1,
  ])("rejects an invalid budget: %s", async (budgetCodeUnits) => {
    expect(() => validateProviderPromptBudget(budgetCodeUnits)).toThrow(RangeError)
    await expect(composeProviderPrompt({
      ...input(baseSnapshot(), "Ship it"),
      budgetCodeUnits,
    })).rejects.toThrow(RangeError)
  })
})

describe("composeProviderPrompt drop order", () => {
  it("drops one item at a time in the documented order and stops once the prompt fits", async () => {
    const snapshot = baseSnapshot()
    const sessionId = snapshot.sessions[0]!.id
    const alpha = skillFixture({
      id: "skill-aaaaaaaaaaaa",
      name: "alpha-skill",
      content: "a".repeat(3_000),
    })
    const beta = skillFixture({
      id: "skill-bbbbbbbbbbbb",
      name: "beta-skill",
      content: "b".repeat(3_000),
    })
    snapshot.skillEnablements = [alpha.review, beta.review]
    snapshot.annotations = [annotation(0), annotation(1)]
    snapshot.artifacts = [{
      id: "artifact-diff",
      sessionId,
      title: "Billing diff",
      type: "diff",
      revision: 1,
      content: "d".repeat(1_000),
    }]
    snapshot.thread = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `history-${index}`,
        sessionId,
        kind: "assistant" as const,
        body: `History ${index} ${"h".repeat(600)}`,
        createdAt: `2026-09-03T12:0${index}:00.000Z`,
      })),
      {
        id: "handoff-1",
        sessionId,
        kind: "system" as const,
        body: "Handed off codex to claude-code.",
        createdAt: "2026-09-03T13:00:00.000Z",
      },
    ]
    const request = {
      ...input(snapshot, "Continue"),
      skillCatalog: {
        list: vi.fn(async () => [alpha.summary, beta.summary]),
        read: vi.fn(async (skillId: string) =>
          skillId === alpha.summary.id ? alpha.document : beta.document,
        ),
      } satisfies SkillCatalog,
    }

    let result = await composeProviderPrompt(request)
    expect(result.providerPromptDelivery).toMatchObject({
      skills: {
        delivered: [
          expect.objectContaining({ id: alpha.summary.id }),
          expect.objectContaining({ id: beta.summary.id }),
        ],
        omitted: { budget: [] },
      },
      annotations: { deliveredIds: ["annotation-1", "annotation-0"], omitted: { budget: 0 } },
      handoff: { status: "delivered", omitted: { threadItems: 0, annotations: 0, artifacts: 0 } },
    })

    const untouched = { threadItems: 0, annotations: 0, artifacts: 0 }
    const stages = [
      {
        skills: [beta.summary.id],
        annotations: ["annotation-1", "annotation-0"],
        handoff: untouched,
        absent: ["beta-skill"],
        present: ["alpha-skill"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: ["annotation-1", "annotation-0"],
        handoff: untouched,
        absent: ["alpha-skill"],
        present: [],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: ["annotation-1"],
        handoff: untouched,
        absent: [],
        present: [],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: untouched,
        absent: ["domovoi_review_context"],
        present: [],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 1, annotations: 0, artifacts: 0 },
        absent: ["History 0"],
        present: ["History 1", "History 2"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 2, annotations: 0, artifacts: 0 },
        absent: ["History 1"],
        present: ["History 2"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 3, annotations: 0, artifacts: 0 },
        absent: ["History 2"],
        present: ["annotation-0", "annotation-1", "artifact-diff"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 3, annotations: 1, artifacts: 0 },
        absent: ["annotation-1"],
        present: ["annotation-0", "artifact-diff"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 3, annotations: 2, artifacts: 0 },
        absent: ["annotation-0"],
        present: ["artifact-diff"],
      },
      {
        skills: [alpha.summary.id, beta.summary.id],
        annotations: [],
        handoff: { threadItems: 3, annotations: 2, artifacts: 1 },
        absent: ["artifact-diff"],
        present: ["Handed off codex to claude-code.", "<user_request>\nContinue\n</user_request>"],
      },
    ]
    for (const stage of stages) {
      const budgetCodeUnits = result.prompt.length - 1
      result = await composeProviderPrompt({ ...request, budgetCodeUnits })
      expect(result.prompt.length).toBeLessThanOrEqual(budgetCodeUnits)
      expect(result.providerPromptDelivery).toMatchObject({
        budget: { limit: budgetCodeUnits, used: result.prompt.length },
        skills: { omitted: { budget: stage.skills } },
        annotations: { deliveredIds: stage.annotations },
        handoff: { status: "delivered", omitted: stage.handoff },
      })
      for (const text of stage.absent) expect(result.prompt).not.toContain(text)
      for (const text of stage.present) expect(result.prompt).toContain(text)
    }

    const budgetCodeUnits = result.prompt.length - 1
    await expect(composeProviderPrompt({ ...request, budgetCodeUnits })).rejects.toThrow(
      `Cannot send this turn: required user request and provider handoff exceed the ${budgetCodeUnits} UTF-16 code units Domovoi payload limit. Shorten the request, start a fresh session and try again.`,
    )
  })
})
