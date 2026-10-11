import { describe, expect, it } from "vitest"

import {
  maximumWorkingPlanStepTextLength,
  workingPlanSchema,
  type Annotation,
  type Artifact,
  type PlanEditParams,
  type WorkingPlan,
  type WorkingPlanClientAttribution,
  type WorkingPlanStepStatus,
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

// Claude's task tools change one task at a time and carry no order: ids count
// up in creation order. The working plan keeps its own order and takes
// Claude's changes onto it.
describe("provider task changes", () => {
  type Task = { id: string, text: string, status: WorkingPlanStepStatus }
  const task = (id: string, text: string, status: WorkingPlanStepStatus = "pending"): Task => ({
    id,
    text,
    status,
  })

  function taskUpdate(
    current: WorkingPlan | undefined,
    previous: Task[],
    next: Task[],
    taskLinks?: ReadonlyMap<string, string>,
    createId: (kind: "edit" | "receipt" | "step") => string = () => {
      throw new Error("no step may be added")
    },
  ) {
    return updateWorkingPlanFromProvider(current, {
      sessionId: "session-a",
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      steps: next.map(({ text, status }) => ({ text, status })),
      taskChange: { previous, current: next },
      ...(taskLinks ? { taskLinks } : {}),
      updatedAt: nextAt,
    }, createId)
  }

  const shape = (result: { plan: WorkingPlan }) => result.plan.steps.map(
    ({ id, text, status }) => `${id}:${text}:${status}`,
  )

  // The person inserted "Write the docs" between Claude's second and third
  // tasks and renamed the second. Claude adopts the delivered edit with a
  // rename, a create and status changes, in either order.
  const edited = () => plan({
    revision: 6,
    structureRevision: 2,
    steps: [
      { id: "step-inspect", text: "Inspect", status: "completed" },
      { id: "step-implement", text: "Implement the parser", status: "pending" },
      { id: "step-docs", text: "Write the docs", status: "pending" },
      { id: "step-verify", text: "Verify", status: "pending" },
    ],
    providerSync: {
      provider: "claude-code",
      model: "claude-opus-5",
      providerThreadId: "thread-a",
      structureRevision: 2,
      deliveredAt: firstAt,
    },
  })
  const claudeBefore = [
    task("1", "Inspect", "completed"),
    task("2", "Implement"),
    task("3", "Verify"),
  ]
  const links = new Map([
    ["1", "step-inspect"],
    ["2", "step-implement"],
    ["3", "step-verify"],
  ])

  // Measured 2026-10-07 with Claude Code 2.1.292: one TaskUpdate renamed task 2
  // and started it, then TaskCreate added the inserted step.
  it.each([
    ["with the daemon's task links", links],
    ["after a daemon restart, with no links", undefined],
  ])("keeps an inserted step in place at every update, %s", (_name, taskLinks) => {
    const renamedTasks = [
      task("1", "Inspect", "completed"),
      task("2", "Implement the parser", "in-progress"),
      task("3", "Verify"),
    ]
    const first = taskUpdate(edited(), claudeBefore, renamedTasks, taskLinks)
    expect(shape(first)).toEqual([
      "step-inspect:Inspect:completed",
      "step-implement:Implement the parser:in-progress",
      "step-docs:Write the docs:pending",
      "step-verify:Verify:pending",
    ])
    expect(first.structureChanged).toBe(false)
    expect(first.plan.structureRevision).toBe(2)

    const created = [...renamedTasks, task("4", "Write the docs")]
    const second = taskUpdate(first.plan, renamedTasks, created, first.taskLinks)
    expect(shape(second)).toEqual(shape(first))
    expect(second.structureChanged).toBe(false)

    const progressed = [
      task("1", "Inspect", "completed"),
      task("2", "Implement the parser", "completed"),
      task("3", "Verify"),
      task("4", "Write the docs", "in-progress"),
    ]
    const third = taskUpdate(second.plan, created, progressed, second.taskLinks)
    expect(shape(third)).toEqual([
      "step-inspect:Inspect:completed",
      "step-implement:Implement the parser:completed",
      "step-docs:Write the docs:in-progress",
      "step-verify:Verify:pending",
    ])
    expect(third.plan.structureRevision).toBe(2)
    expect(third.taskLinks).toEqual(new Map([
      ["1", "step-inspect"],
      ["2", "step-implement"],
      ["3", "step-verify"],
      ["4", "step-docs"],
    ]))
  })

  it("keeps an inserted step in place when Claude creates it before the rename", () => {
    const created = [...claudeBefore, task("4", "Write the docs")]
    const first = taskUpdate(edited(), claudeBefore, created, links)
    expect(shape(first)).toEqual([
      "step-inspect:Inspect:completed",
      "step-implement:Implement the parser:pending",
      "step-docs:Write the docs:pending",
      "step-verify:Verify:pending",
    ])
    expect(first.structureChanged).toBe(false)

    // A status change on the task the person renamed lands on the renamed step.
    const started = created.map((candidate) => candidate.id === "2"
      ? { ...candidate, status: "in-progress" as const }
      : candidate)
    const second = taskUpdate(first.plan, created, started, first.taskLinks)
    expect(shape(second)).toEqual([
      "step-inspect:Inspect:completed",
      "step-implement:Implement the parser:in-progress",
      "step-docs:Write the docs:pending",
      "step-verify:Verify:pending",
    ])

    const renamed = started.map((candidate) => candidate.id === "2"
      ? { ...candidate, text: "Implement the parser" }
      : candidate)
    const third = taskUpdate(second.plan, started, renamed, second.taskLinks)
    expect(shape(third)).toEqual(shape(second))
    expect(third.changed).toBe(false)
  })

  it("renames a step in place when Claude rewords its task", () => {
    const current = plan({
      steps: [
        { id: "step-1", text: "Inspect", status: "completed" },
        { id: "step-2", text: "Implement", status: "pending" },
        { id: "step-3", text: "Verify", status: "pending" },
      ],
    })
    const before = [task("1", "Inspect", "completed"), task("2", "Implement"), task("3", "Verify")]
    const after = [task("1", "Inspect", "completed"), task("2", "Implement the fix"), task("3", "Verify")]
    for (const taskLinks of [undefined, new Map([["1", "step-1"], ["2", "step-2"], ["3", "step-3"]])]) {
      const result = taskUpdate(current, before, after, taskLinks)
      expect(shape(result)).toEqual([
        "step-1:Inspect:completed",
        "step-2:Implement the fix:pending",
        "step-3:Verify:pending",
      ])
      expect(result.structureChanged).toBe(true)
    }
  })

  it("appends a reworded task that matches no step instead of dropping it", () => {
    // The person renamed Implement to Build it. Claude, with no link to the
    // step, rewords its own task to a third text.
    const current = plan({
      steps: [
        { id: "step-1", text: "Inspect", status: "completed" },
        { id: "step-2", text: "Build it", status: "pending" },
        { id: "step-3", text: "Verify", status: "pending" },
      ],
    })
    const result = taskUpdate(
      current,
      [task("1", "Inspect", "completed"), task("2", "Implement"), task("3", "Verify")],
      [task("1", "Inspect", "completed"), task("2", "Implement the fix", "in-progress"), task("3", "Verify")],
      undefined,
      ids("step-new"),
    )
    expect(shape(result)).toEqual([
      "step-1:Inspect:completed",
      "step-2:Build it:pending",
      "step-3:Verify:pending",
      "step-new:Implement the fix:in-progress",
    ])
  })

  it("appends a task the plan never had after the steps it has", () => {
    const current = plan({
      steps: [
        { id: "step-1", text: "Inspect", status: "completed" },
        { id: "step-docs", text: "Write the docs", status: "pending" },
        { id: "step-3", text: "Verify", status: "pending" },
      ],
    })
    const before = [task("1", "Inspect", "completed"), task("2", "Verify")]
    const result = taskUpdate(
      current,
      before,
      [...before, task("3", "Run the linter")],
      new Map([["1", "step-1"], ["2", "step-3"]]),
      ids("step-lint"),
    )
    expect(shape(result)).toEqual([
      "step-1:Inspect:completed",
      "step-docs:Write the docs:pending",
      "step-3:Verify:pending",
      "step-lint:Run the linter:pending",
    ])
    expect(result.taskLinks?.get("3")).toBe("step-lint")
  })

  it("pairs steps that share a subject with tasks in plan order", () => {
    const current = plan({
      steps: [
        { id: "step-a", text: "Run tests", status: "pending" },
        { id: "step-b", text: "Fix", status: "pending" },
        { id: "step-c", text: "Run tests", status: "pending" },
      ],
    })
    const before = [task("1", "Run tests"), task("2", "Fix"), task("3", "Run tests")]
    const after = [task("1", "Run tests", "completed"), task("2", "Fix"), task("3", "Run tests"), task("4", "Run tests")]
    for (const taskLinks of [undefined, new Map([["1", "step-a"], ["2", "step-b"], ["3", "step-c"]])]) {
      const result = taskUpdate(current, before, after, taskLinks, ids("step-d"))
      expect(shape(result)).toEqual([
        "step-a:Run tests:completed",
        "step-b:Fix:pending",
        "step-c:Run tests:pending",
        "step-d:Run tests:pending",
      ])
    }
  })

  it("removes the step of a task Claude deletes", () => {
    const current = plan({
      steps: [
        { id: "step-1", text: "Inspect", status: "completed" },
        { id: "step-2", text: "Implement", status: "pending" },
        { id: "step-3", text: "Verify", status: "pending" },
      ],
    })
    const before = [task("1", "Inspect", "completed"), task("2", "Implement"), task("3", "Verify")]
    for (const taskLinks of [undefined, new Map([["1", "step-1"], ["2", "step-2"], ["3", "step-3"]])]) {
      const result = taskUpdate(current, before, [before[0]!, before[2]!], taskLinks)
      expect(shape(result)).toEqual(["step-1:Inspect:completed", "step-3:Verify:pending"])
    }
  })

  it("keeps a step the person removed out of the plan until Claude changes its task", () => {
    const current = plan({
      steps: [
        { id: "step-1", text: "Inspect", status: "in-progress" },
        { id: "step-2", text: "Implement", status: "pending" },
      ],
    })
    const before = [task("1", "Inspect", "in-progress"), task("2", "Implement"), task("3", "Verify")]
    const removedLinks = new Map([["1", "step-1"], ["2", "step-2"], ["3", "step-verify-removed"]])
    const progressed = [task("1", "Inspect", "completed"), task("2", "Implement"), task("3", "Verify")]
    const first = taskUpdate(current, before, progressed, removedLinks)
    expect(shape(first)).toEqual(["step-1:Inspect:completed", "step-2:Implement:pending"])

    const deleted = taskUpdate(first.plan, progressed, progressed.slice(0, 2), first.taskLinks)
    expect(shape(deleted)).toEqual(shape(first))

    // Claude works on it anyway: its progress is shown, not dropped.
    const started = [task("1", "Inspect", "completed"), task("2", "Implement"), task("3", "Verify", "in-progress")]
    const resumed = taskUpdate(first.plan, progressed, started, first.taskLinks, ids("step-verify-again"))
    expect(shape(resumed)).toEqual([
      "step-1:Inspect:completed",
      "step-2:Implement:pending",
      "step-verify-again:Verify:in-progress",
    ])
  })

  it("builds a first plan in Claude's creation order", () => {
    const result = taskUpdate(
      undefined,
      [],
      [task("1", "Inspect"), task("2", "Run TOKEN=task-plan-secret")],
      undefined,
      ids("step-1", "step-2"),
    )
    expect(shape(result)).toEqual([
      "step-1:Inspect:pending",
      "step-2:Run TOKEN=[REDACTED]:pending",
    ])
    expect(result.plan.structureRevision).toBe(1)
    expect(JSON.stringify(result.plan)).not.toContain("task-plan-secret")
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

  // The artifact watcher names plan files found in the worktree
  // plan-<sessionId>-<hash> and always records their path. Turn-scoped
  // working plans never had a path, so a path marks a file artifact.
  it("leaves watched plan files and their annotations alone", () => {
    const watched: Artifact = {
      id: "plan-session-a-0123456789abcdef",
      sessionId: "session-a",
      title: "Plan",
      type: "plan",
      revision: 2,
      path: "PLAN.md",
      mimeType: "text/markdown",
      content: "# Agent plan\n",
    }
    const artifacts: Artifact[] = [
      { ...watched },
      {
        id: "plan-session-a-current",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan",
        revision: 1,
        mimeType: "text/markdown",
        content: "Legacy plan",
      },
    ]
    const annotations: Annotation[] = [
      {
        id: "annotation-file",
        sessionId: "session-a",
        artifactId: watched.id,
        anchor: { textQuote: "Agent plan" },
        body: "Comment on the file",
        status: "open",
        origin: "desktop",
        thread: [],
        createdAt: firstAt,
        updatedAt: firstAt,
      },
      {
        id: "annotation-legacy",
        sessionId: "session-a",
        artifactId: "plan-session-a-current",
        anchor: { textQuote: "Legacy plan" },
        body: "Comment on the legacy plan",
        status: "open",
        origin: "desktop",
        thread: [],
        createdAt: firstAt,
        updatedAt: firstAt,
      },
    ]

    const first = syncWorkingPlanArtifact(artifacts, annotations, plan(), true)
    expect(first.artifact).toMatchObject({ id: "plan-session-a", revision: 2 })
    const second = syncWorkingPlanArtifact(artifacts, annotations, plan({ revision: 3 }), true)
    expect(second.artifact).toMatchObject({ id: "plan-session-a", revision: 3 })

    expect(artifacts.map(({ id }) => id).sort()).toEqual([
      "plan-session-a",
      "plan-session-a-0123456789abcdef",
    ])
    expect(artifacts.find(({ id }) => id === watched.id)).toEqual(watched)
    expect(annotations.map(({ artifactId }) => artifactId)).toEqual([
      watched.id,
      "plan-session-a",
    ])
  })

  it("creates the working plan beside a watched plan file", () => {
    const watched: Artifact = {
      id: "plan-session-a-0123456789abcdef",
      sessionId: "session-a",
      title: "Plan",
      type: "plan",
      revision: 1,
      path: "PLAN.md",
      mimeType: "text/markdown",
      content: "# Agent plan\n",
    }
    const artifacts: Artifact[] = [{ ...watched }]

    const result = syncWorkingPlanArtifact(artifacts, [], plan(), true)

    expect(result.artifact).toMatchObject({ id: "plan-session-a", revision: 1 })
    expect(artifacts.find(({ id }) => id === watched.id)).toEqual(watched)
    expect(artifacts).toHaveLength(2)
  })

  // Before the watched-file fix, a plan delta could rename a watched plan
  // file to plan-<sessionId> and keep its path. A saved profile can still
  // hold that artifact; it is the working plan, not a second one.
  it("takes over a saved working plan that kept a watched file's path", () => {
    const artifacts: Artifact[] = [{
      id: "plan-session-a",
      sessionId: "session-a",
      title: "Working plan",
      type: "plan",
      revision: 2,
      path: "PLAN.md",
      variant: { id: "variant-a", groupId: "plans", label: "A", order: 0 },
      mimeType: "text/markdown",
      content: "# Agent plan\n",
    }]

    const result = syncWorkingPlanArtifact(artifacts, [], plan(), true)

    expect(artifacts.filter(({ id }) => id === "plan-session-a")).toHaveLength(1)
    expect(artifacts).toHaveLength(1)
    expect(result.artifact).toBe(artifacts[0])
    expect(result.artifact).toMatchObject({ id: "plan-session-a", revision: 3 })
    expect(result.artifact).not.toHaveProperty("path")
    expect(result.artifact).not.toHaveProperty("variant")
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
