import { describe, expect, it } from "vitest"

import {
  maximumWorkingPlanStepTextLength,
  workingPlanSchema,
  type Annotation,
  type Artifact,
  type PlanEditParams,
  type WorkingPlan,
  type WorkingPlanClientAttribution,
} from "@getdomovoi/protocol"

import {
  agentPromptWithWorkingPlan,
  blockWorkingPlanForApproval,
  clearWorkingPlanApprovalBlockers,
  discardPendingWorkingPlanEdit,
  finalizePendingWorkingPlanEdit,
  markWorkingPlanDelivered,
  submitWorkingPlanEdit,
  syncWorkingPlanArtifact,
  updateWorkingPlanFromProvider,
  workingPlanNeedsProviderDelivery,
} from "./working-plan.js"

const firstAt = "2026-09-03T20:00:00.000Z"
const nextAt = "2026-09-03T20:01:00.000Z"
const attribution: WorkingPlanClientAttribution = {
  client: "desktop",
  connectionId: "11111111-1111-4111-8111-111111111111",
  clientId: "desktop-primary",
}

function ids(...values: string[]): (kind: "edit" | "receipt" | "step") => string {
  return (kind) => values.shift() ?? `${kind}-fallback`
}

function plan(overrides: Partial<WorkingPlan> = {}): WorkingPlan {
  return {
    sessionId: "session-a",
    revision: 2,
    structureRevision: 1,
    steps: [
      { id: "step-inspect", text: "Inspect the handler", status: "completed" },
      { id: "step-test", text: "Add a regression test", status: "in-progress" },
    ],
    providerSync: {
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      structureRevision: 1,
      deliveredAt: firstAt,
    },
    createdAt: firstAt,
    updatedAt: firstAt,
    ...overrides,
  }
}

describe("provider working-plan updates", () => {
  it("redacts and bounds provider text before creating durable state", () => {
    const secret = "sk-provider-plan-secret"
    const result = updateWorkingPlanFromProvider(undefined, {
      sessionId: "session-a",
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      steps: [
        { text: `Run --api-key ${secret}`, status: "in-progress" },
        { text: "x".repeat(10_000), status: "pending" },
      ],
      updatedAt: firstAt,
    }, ids("step-secret", "step-long"))

    expect(result.structureChanged).toBe(true)
    expect(result.plan).toMatchObject({
      revision: 1,
      structureRevision: 1,
      steps: [
        { id: "step-secret", text: "Run --api-key [REDACTED]", status: "in-progress" },
        { id: "step-long", status: "pending" },
      ],
      providerSync: {
        provider: "claude-code",
        model: "claude-opus-5",
        providerThreadId: "thread-a",
        structureRevision: 1,
      },
    })
    expect(result.plan.steps[1]!.text.length).toBeLessThanOrEqual(
      maximumWorkingPlanStepTextLength,
    )
    expect(JSON.stringify(result.plan)).not.toContain(secret)
    expect(workingPlanSchema.safeParse(result.plan).success).toBe(true)
  })

  it("updates progress without changing structure identity", () => {
    const current = plan()
    const result = updateWorkingPlanFromProvider(current, {
      sessionId: current.sessionId,
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      steps: [
        { text: "Inspect the handler", status: "completed" },
        { text: "Add a regression test", status: "completed" },
      ],
      updatedAt: nextAt,
    }, () => { throw new Error("status-only updates cannot mint step ids") })

    expect(result.structureChanged).toBe(false)
    expect(result.plan.structureRevision).toBe(1)
    expect(result.plan.revision).toBe(3)
    expect(result.plan.steps.map(({ id }) => id)).toEqual(["step-inspect", "step-test"])
    expect(result.plan.steps[1]!.status).toBe("completed")
  })

  it("preserves unique ids through reorder and conflicts a queued draft", () => {
    const current = plan({
      pendingEdit: {
        id: "edit-a",
        basedOnStructureRevision: 1,
        baseSteps: [
          { id: "step-inspect", text: "Inspect the handler" },
          { id: "step-test", text: "Add a regression test" },
        ],
        draftSteps: [
          { id: "step-test", text: "Add a regression test" },
          { id: "step-inspect", text: "Inspect the handler carefully" },
        ],
        status: "queued",
        submittedAt: firstAt,
        submittedBy: attribution,
      },
    })
    const result = updateWorkingPlanFromProvider(current, {
      sessionId: current.sessionId,
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      steps: [
        { text: "Add a regression test", status: "completed" },
        { text: "Inspect the handler", status: "completed" },
      ],
      updatedAt: nextAt,
    }, () => { throw new Error("unique exact matches must retain ids") })

    expect(result.structureChanged).toBe(true)
    expect(result.plan.structureRevision).toBe(2)
    expect(result.plan.steps.map(({ id }) => id)).toEqual(["step-test", "step-inspect"])
    expect(result.plan.pendingEdit).toMatchObject({
      id: "edit-a",
      status: "conflicted",
      draftSteps: current.pendingEdit!.draftSteps,
    })
  })

  it("does not guess identity for duplicate provider step text", () => {
    const current = plan({
      steps: [
        { id: "duplicate-a", text: "Run tests", status: "pending" },
        { id: "duplicate-b", text: "Run tests", status: "pending" },
      ],
    })
    const result = updateWorkingPlanFromProvider(current, {
      sessionId: current.sessionId,
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      steps: [
        { text: "Run tests", status: "completed" },
        { text: "Run tests", status: "pending" },
      ],
      updatedAt: nextAt,
    }, ids("duplicate-new-a", "duplicate-new-b"))

    expect(result.plan.steps.map(({ id }) => id)).toEqual([
      "duplicate-new-a",
      "duplicate-new-b",
    ])
    expect(result.structureChanged).toBe(true)
  })
})

describe("working-plan artifacts", () => {
  it("takes over the stable artifact id and preserves annotation attachment", () => {
    const artifacts: Artifact[] = [
      {
        id: "plan-session-a-turn-1",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan",
        revision: 2,
        mimeType: "text/markdown",
        content: "Legacy plan",
      },
      {
        id: "plan-from-file",
        sessionId: "session-a",
        title: "Authored plan",
        type: "plan",
        revision: 4,
        path: "plans/authored.md",
      },
    ]
    const annotations: Annotation[] = [{
      id: "annotation-plan",
      sessionId: "session-a",
      artifactId: "plan-session-a-turn-1",
      anchor: { textQuote: "Legacy plan" },
      body: "Keep the intent",
      status: "open",
      origin: "desktop",
      thread: [],
      createdAt: firstAt,
      updatedAt: firstAt,
    }]

    const result = syncWorkingPlanArtifact(artifacts, annotations, plan(), true)

    expect(result.changed).toBe(true)
    expect(result.artifact).toMatchObject({
      id: "plan-session-a",
      revision: 3,
      content: "# Working plan\n\n1. Inspect the handler\n2. Add a regression test\n",
    })
    expect(result.artifact.content).not.toMatch(/completed|in-progress/)
    expect(annotations[0]!.artifactId).toBe("plan-session-a")
    expect(artifacts.find(({ id }) => id === "plan-from-file")).toBeDefined()

    const revision = result.artifact.revision
    expect(syncWorkingPlanArtifact(artifacts, annotations, plan({ revision: 3 }), false)).toEqual({
      artifact: result.artifact,
      changed: false,
    })
    expect(result.artifact.revision).toBe(revision)
  })
})

describe("working-plan provider delivery", () => {
  it("sends only canonical steps and pins delivery to a provider runtime", () => {
    const current = plan({
      revision: 3,
      structureRevision: 2,
      pendingEdit: {
        id: "edit-queued",
        basedOnStructureRevision: 2,
        baseSteps: [
          { id: "step-inspect", text: "Inspect the handler" },
          { id: "step-test", text: "Add a regression test" },
        ],
        draftSteps: [{ id: "step-test", text: "Do not send this draft" }],
        status: "queued",
        submittedAt: firstAt,
        submittedBy: attribution,
      },
    })
    const target = {
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
    }

    expect(workingPlanNeedsProviderDelivery(current, target)).toBe(true)
    const prompt = agentPromptWithWorkingPlan(current, "Continue safely")
    expect(prompt).toContain("<domovoi_working_plan>")
    expect(prompt).toContain('"structureRevision":2')
    expect(prompt).toContain('"text":"Add a regression test"')
    expect(prompt).not.toContain("Do not send this draft")
    expect(prompt).toContain("Continue safely")

    const delivered = markWorkingPlanDelivered(current, target, nextAt)
    expect(delivered).toMatchObject({
      revision: 4,
      providerSync: {
        ...target,
        structureRevision: 2,
        deliveredAt: nextAt,
      },
    })
    expect(workingPlanNeedsProviderDelivery(delivered, target)).toBe(false)
    expect(workingPlanNeedsProviderDelivery(delivered, {
      ...target,
      model: "claude-sonnet-5",
    })).toBe(true)
    expect(markWorkingPlanDelivered(delivered, target, nextAt)).toBe(delivered)
  })
})

describe("human working-plan edits", () => {
  it("queues the first plan behind a pinned turn with server-assigned ids", () => {
    const params: PlanEditParams = {
      sessionId: "session-a",
      basedOnStructureRevision: 0,
      baseSteps: [],
      draftSteps: [{ text: "Inspect" }, { text: "Implement" }],
      client: "desktop",
    }
    const result = submitWorkingPlanEdit(
      undefined,
      params,
      attribution,
      true,
      firstAt,
      ids("edit-first", "receipt-first", "step-first", "step-second"),
    )

    expect(result.receipt).toMatchObject({
      editId: "edit-first",
      id: "receipt-first",
      disposition: "queued",
      basedOnStructureRevision: 0,
      planRevision: 1,
      structureRevision: 0,
      ...attribution,
    })
    expect(result.plan).toMatchObject({
      revision: 1,
      structureRevision: 0,
      steps: [],
      pendingEdit: {
        status: "queued",
        draftSteps: [
          { id: "step-first", text: "Inspect" },
          { id: "step-second", text: "Implement" },
        ],
      },
    })
  })

  it("applies an idle edit while preserving progress by id", () => {
    const current = plan()
    const result = submitWorkingPlanEdit(
      current,
      {
        sessionId: current.sessionId,
        basedOnStructureRevision: 1,
        baseSteps: current.steps.map(({ id, text }) => ({ id, text })),
        draftSteps: [
          { id: "step-test", text: "Add a stronger regression test" },
          { text: "Run the daemon suite" },
        ],
        client: "desktop",
      },
      attribution,
      false,
      nextAt,
      ids("edit-idle", "receipt-idle", "step-suite"),
    )

    expect(result.receipt.disposition).toBe("applied")
    expect(result.plan).toMatchObject({
      revision: 3,
      structureRevision: 2,
      steps: [
        { id: "step-test", text: "Add a stronger regression test", status: "in-progress" },
        { id: "step-suite", text: "Run the daemon suite", status: "pending" },
      ],
    })
    expect(result.plan.pendingEdit).toBeUndefined()
    expect(result.plan.providerSync?.structureRevision).toBe(1)
  })

  it("persists stale typed work as a conflict instead of discarding it", () => {
    const current = plan()
    const result = submitWorkingPlanEdit(
      current,
      {
        sessionId: current.sessionId,
        basedOnStructureRevision: 0,
        baseSteps: [],
        draftSteps: [{ text: "TOKEN=typed-secret then inspect" }],
        client: "desktop",
      },
      attribution,
      false,
      nextAt,
      ids("edit-stale", "receipt-stale", "step-stale"),
    )

    expect(result.receipt.disposition).toBe("conflicted")
    expect(result.plan.steps).toEqual(current.steps)
    expect(result.plan.pendingEdit).toMatchObject({
      status: "conflicted",
      baseSteps: [],
      draftSteps: [{ id: "step-stale", text: "TOKEN=[REDACTED] then inspect" }],
    })
    expect(JSON.stringify(result)).not.toContain("typed-secret")
  })

  it("applies queued edits at the turn boundary using the latest progress", () => {
    const queued = submitWorkingPlanEdit(
      plan(),
      {
        sessionId: "session-a",
        basedOnStructureRevision: 1,
        baseSteps: [
          { id: "step-inspect", text: "Inspect the handler" },
          { id: "step-test", text: "Add a regression test" },
        ],
        draftSteps: [
          { id: "step-test", text: "Add a stronger regression test" },
          { id: "step-inspect", text: "Inspect the handler" },
        ],
        client: "desktop",
      },
      attribution,
      true,
      firstAt,
      ids("edit-queued", "receipt-queued"),
    ).plan
    queued.steps[1]!.status = "completed"

    const finalized = finalizePendingWorkingPlanEdit(queued, nextAt)

    expect(finalized.disposition).toBe("applied")
    expect(finalized.plan.pendingEdit).toBeUndefined()
    expect(finalized.plan.structureRevision).toBe(2)
    expect(finalized.plan.steps).toEqual([
      { id: "step-test", text: "Add a stronger regression test", status: "completed" },
      { id: "step-inspect", text: "Inspect the handler", status: "completed" },
    ])
  })

  it("binds only an unambiguous active step and clears approval blockers atomically", () => {
    const current = plan({
      revision: 3,
      steps: [
        { id: "step-inspect", text: "Inspect the handler", status: "completed" },
        { id: "step-test", text: "Add a regression test", status: "in-progress" },
      ],
      pendingEdit: {
        id: "edit-a",
        basedOnStructureRevision: 1,
        baseSteps: [
          { id: "step-inspect", text: "Inspect the handler" },
          { id: "step-test", text: "Add a regression test" },
        ],
        draftSteps: [{ id: "step-test", text: "Add a stronger test" }],
        status: "queued",
        submittedAt: firstAt,
        submittedBy: attribution,
      },
    })
    const discarded = discardPendingWorkingPlanEdit(
      current,
      "edit-a",
      attribution,
      nextAt,
      ids("receipt-discard"),
    )
    expect(discarded.receipt.disposition).toBe("discarded")
    expect(discarded.plan.pendingEdit).toBeUndefined()

    const blocked = blockWorkingPlanForApproval(
      [discarded.plan],
      "session-a",
      "approval-a",
      nextAt,
    )
    expect(blocked.changed).toBe(true)
    expect(blocked.plans[0]!.steps[1]!.blocker).toEqual({
      kind: "approval",
      approvalId: "approval-a",
    })

    const cleared = clearWorkingPlanApprovalBlockers(
      blocked.plans,
      new Set(["approval-a"]),
      nextAt,
    )
    expect(cleared.changedSessionIds).toEqual(["session-a"])
    expect(cleared.plans[0]!.steps[1]!.blocker).toBeUndefined()

    const ambiguous = blockWorkingPlanForApproval(
      [plan({
        steps: [
          { id: "step-a", text: "First", status: "in-progress" },
          { id: "step-b", text: "Second", status: "in-progress" },
        ],
      })],
      "session-a",
      "approval-b",
      nextAt,
    )
    expect(ambiguous.changed).toBe(false)
    expect(ambiguous.plans[0]!.steps.every((step) => step.blocker === undefined)).toBe(true)
  })
})
