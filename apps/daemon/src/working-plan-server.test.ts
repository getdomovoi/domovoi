import { waitForDaemon } from "./test-wait-for.js"
import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  demoWorkspace,
  protocolVersion,
  type RpcMethod,
  type RpcResult,
} from "@getdomovoi/protocol"

import type { AuditLog } from "./audit-log.js"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"

const running: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

function auditLog() {
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-plan-${append.mock.calls.length}`,
    occurredAt: "2026-09-03T20:00:00.000Z",
    ...input,
  }))
  return {
    append,
    log: {
      append,
      query: vi.fn(() => ({ entries: [], hasMore: false })),
      export: vi.fn(() => ({
        format: "jsonl" as const,
        exportedAt: "2026-09-03T20:00:00.000Z",
        content: "",
        entryCount: 0,
        hasMore: false,
      })),
    } satisfies AuditLog,
  }
}

async function startedDaemon(
  snapshot: typeof demoWorkspace,
  agents: Record<string, AgentAdapter> = {},
) {
  let durable = structuredClone(snapshot)
  const store = {
    load: () => structuredClone(durable),
    save: vi.fn((next: typeof snapshot) => { durable = structuredClone(next) }),
    close: vi.fn(),
  } satisfies WorkspaceStore
  const audit = auditLog()
  const daemon = new DomovoiDaemon({
    port: 0,
    store,
    agents,
    auditLog: audit.log,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
  })
  running.push(daemon)
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  let nextId = 0
  const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
    const id = ++nextId
    return new Promise<Record<string, unknown> & { result: RpcResult<M> }>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & {
          id?: number
          result: RpcResult<M>
        }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  const hello = await rpc("system.hello", {
    client: "desktop",
    clientId: "desktop-plan-test",
    clientVersion: "0.0.1",
    protocolVersion,
  })
  return {
    daemon,
    socket,
    rpc,
    audit: audit.append,
    connectionId: (hello.result as typeof hello.result & { connectionId: string }).connectionId,
    durable: () => durable,
    save: store.save,
  }
}

describe("working plan RPC", () => {
  it("asks for a native plan and mirrors the final reply when no plan event arrives", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "plan",
      auto: false,
    }
    session.workspacePath = "/worktrees/plan-fallback"
    session.providerThreadId = "thread-plan-fallback"
    delete session.activeTurnId
    snapshot.workingPlans = []
    snapshot.artifacts = snapshot.artifacts.filter(
      (artifact) => artifact.sessionId !== session.id || artifact.type !== "plan",
    )
    snapshot.annotations = snapshot.annotations.filter(
      (annotation) => annotation.sessionId !== session.id,
    )
    let emit: ((event: AgentEvent) => void) | undefined
    const turnIds = ["turn-plan-fallback", "turn-native-plan", "turn-no-reply"]
    const startTurn = vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => (
      turnIds.shift()!
    ))
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn,
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        emit = listener
        return () => { emit = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const context = await startedDaemon(snapshot, { codex: agent })

    await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Plan the composer work",
      client: "desktop",
    })
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("provider's native plan mechanism"),
    }))
    expect(startTurn.mock.calls[0]![0].prompt).toContain("Plan the composer work")

    emit!({
      type: "text-delta",
      threadId: "thread-plan-fallback",
      turnId: "turn-plan-fallback",
      itemId: "final-plan",
      delta: [
        "Plan ready.",
        "<proposed_plan>",
        "# Composer plan",
        "",
        "## Approach",
        "",
        "1. Compare the available options.",
        "",
        "## Steps (in order)",
        "",
        "### Step 1: Inspect the composer.",
        "Files: `packages/ui/src/thread.tsx`.",
        "",
        "### Step 2: Implement the fix.",
        "Stops for approval: no.",
        "",
        "```text",
        "1. This is an example, not a step.",
        "```",
        "",
        "## Risks",
        "",
        "1. The composer may have platform-specific behavior.",
        "</proposed_plan>",
        "Let me know what to refine.",
      ].join("\n"),
    })
    emit!({
      type: "turn-completed",
      params: {
        threadId: "thread-plan-fallback",
        turnId: "turn-plan-fallback",
        turn: { id: "turn-plan-fallback", status: "completed" },
      },
    })

    await waitForDaemon(() => expect(context.durable().artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `plan-${session.id}`,
        sessionId: session.id,
        title: "Working plan",
        type: "plan",
        mimeType: "text/markdown",
        content: [
          "# Composer plan",
          "",
          "## Approach",
          "",
          "1. Compare the available options.",
          "",
          "## Steps (in order)",
          "",
          "### Step 1: Inspect the composer.",
          "Files: `packages/ui/src/thread.tsx`.",
          "",
          "### Step 2: Implement the fix.",
          "Stops for approval: no.",
          "",
          "```text",
          "1. This is an example, not a step.",
          "```",
          "",
          "## Risks",
          "",
          "1. The composer may have platform-specific behavior.",
        ].join("\n"),
      }),
    ])))
    expect(context.durable().workingPlans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: session.id,
        steps: [
          expect.objectContaining({ text: "Inspect the composer.", status: "pending" }),
          expect.objectContaining({ text: "Implement the fix.", status: "pending" }),
        ],
      }),
    ]))
    expect(context.durable().thread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant",
        body: expect.stringContaining("Plan ready.\n\n# Composer plan"),
      }),
    ]))
    const finalPlanReply = context.durable().thread.find(
      (item) => item.kind === "assistant" && item.id.includes("final-plan"),
    )
    expect(finalPlanReply?.kind).toBe("assistant")
    if (finalPlanReply?.kind !== "assistant") throw new Error("Expected finalized plan reply")
    expect(finalPlanReply.body).toContain("Let me know what to refine.")
    expect(finalPlanReply.body).toContain(
      "1. The composer may have platform-specific behavior.\n\nLet me know what to refine.",
    )
    expect(finalPlanReply.body).not.toContain("<proposed_plan>")
    expect(finalPlanReply.body).not.toContain("</proposed_plan>")

    await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Refine the plan",
      client: "desktop",
    })
    emit!({
      type: "plan-updated",
      threadId: "thread-plan-fallback",
      turnId: "turn-native-plan",
      steps: [{ text: "Use the provider plan", status: "pending" }],
    })
    emit!({
      type: "text-delta",
      threadId: "thread-plan-fallback",
      turnId: "turn-native-plan",
      itemId: "native-plan-summary",
      delta: "I updated the plan.",
    })
    emit!({
      type: "turn-completed",
      params: {
        threadId: "thread-plan-fallback",
        turnId: "turn-native-plan",
        turn: { id: "turn-native-plan", status: "completed" },
      },
    })
    await waitForDaemon(() => {
      const artifact = context.durable().artifacts.find(
        (candidate) => candidate.id === `plan-${session.id}`,
      )
      expect(artifact?.content).toContain("Use the provider plan")
      expect(artifact?.content).not.toContain("I updated the plan.")
    })

    await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Check whether the plan needs changes",
      client: "desktop",
    })
    const savesBeforeCompletion = context.save.mock.calls.length
    emit!({
      type: "turn-completed",
      params: { threadId: "thread-plan-fallback", status: "completed" },
    })
    await waitForDaemon(() => {
      expect(context.save.mock.calls.length).toBeGreaterThan(savesBeforeCompletion)
      const artifact = context.durable().artifacts.find(
        (candidate) => candidate.id === `plan-${session.id}`,
      )
      expect(artifact?.content).toContain("Use the provider plan")
      expect(artifact?.content).not.toContain("I updated the plan.")
    })
    context.socket.close()
  })

  describe("the mode a turn was sent in", () => {
    async function turnInMode(permissionMode: "build" | "plan") {
      const snapshot = structuredClone(demoWorkspace)
      const session = snapshot.sessions[0]!
      session.state = "idle"
      session.runtime = {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        permissionMode,
        auto: false,
      }
      session.workspacePath = "/worktrees/plan-mode-turn"
      session.providerThreadId = "thread-mode-turn"
      delete session.activeTurnId
      snapshot.workingPlans = []
      snapshot.artifacts = snapshot.artifacts.filter(
        (artifact) => artifact.sessionId !== session.id || artifact.type !== "plan",
      )
      snapshot.annotations = snapshot.annotations.filter(
        (annotation) => annotation.sessionId !== session.id,
      )
      let emit: ((event: AgentEvent) => void) | undefined
      const agent = {
        connect: vi.fn(async () => {}),
        listModels: vi.fn(async () => [{
          provider: "codex" as const,
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Coding model",
          supportedReasoningEfforts: ["medium" as const],
          defaultReasoningEffort: "medium" as const,
          isDefault: true,
        }]),
        startThread: vi.fn(async () => "unused"),
        resumeThread: vi.fn(async () => {}),
        stopThread: vi.fn(async () => {}),
        startTurn: vi.fn(async () => "turn-mode"),
        steerTurn: vi.fn(async () => {}),
        interruptTurn: vi.fn(async () => {}),
        resolveApproval: vi.fn(),
        onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
          emit = listener
          return () => { emit = undefined }
        }),
        close: vi.fn(async () => {}),
      } satisfies AgentAdapter
      const context = await startedDaemon(snapshot, { codex: agent })
      await context.rpc("session.send", {
        sessionId: session.id,
        prompt: "Work on the composer",
        client: "desktop",
      })
      const finish = async (nextMode: "build" | "plan") => {
        const changed = await context.rpc("session.setRuntime", {
          sessionId: session.id,
          client: "desktop",
          runtime: { ...session.runtime, permissionMode: nextMode },
        })
        expect(changed).not.toHaveProperty("error")
        emit!({
          type: "text-delta",
          threadId: "thread-mode-turn",
          turnId: "turn-mode",
          itemId: "final-reply",
          delta: "# Summary\n\n1. Changed the composer.\n2. Ran the tests.",
        })
        emit!({
          type: "turn-completed",
          params: {
            threadId: "thread-mode-turn",
            turnId: "turn-mode",
            turn: { id: "turn-mode", status: "completed" },
          },
        })
        await waitForDaemon(() => expect(context.durable().sessions.find(
          (candidate) => candidate.id === session.id,
        )?.activeTurnId).toBeUndefined())
      }
      return { context, session, finish }
    }

    it("does not read a Build turn's reply as a plan when Plan is picked for the next turn", async () => {
      const { context, session, finish } = await turnInMode("build")
      await finish("plan")

      expect(context.durable().workingPlans.filter((plan) => plan.sessionId === session.id)).toEqual([])
      expect(context.durable().artifacts.find((artifact) => artifact.id === `plan-${session.id}`))
        .toBeUndefined()
      context.socket.close()
    })

    it("still captures a Plan turn's reply when Build is picked for the next turn", async () => {
      const { context, session, finish } = await turnInMode("plan")
      await finish("build")

      await waitForDaemon(() => expect(context.durable().workingPlans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          steps: [
            expect.objectContaining({ text: "Changed the composer.", status: "pending" }),
            expect.objectContaining({ text: "Ran the tests.", status: "pending" }),
          ],
        }),
      ])))
      context.socket.close()
    })
  })

  it("persists an attributed idle edit after redaction and updates only the derived plan", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.workingPlans = [{
      sessionId: session.id,
      revision: 1,
      structureRevision: 1,
      steps: [{ id: "step-existing", text: "Inspect", status: "completed" }],
      createdAt: "2026-09-03T19:00:00.000Z",
      updatedAt: "2026-09-03T19:00:00.000Z",
    }]
    snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.sessionId !== session.id)
    snapshot.artifacts.push({
      id: `plan-${session.id}-turn-old`,
      sessionId: session.id,
      title: "Old plan",
      type: "plan",
      revision: 2,
      mimeType: "text/markdown",
      content: "Old plan",
    })
    snapshot.annotations = snapshot.annotations.filter(
      (annotation) => annotation.sessionId !== session.id,
    )
    snapshot.annotations.push({
      id: "annotation-working-plan",
      sessionId: session.id,
      artifactId: `plan-${session.id}-turn-old`,
      anchor: { textQuote: "Old plan" },
      body: "Preserve this review",
      status: "open",
      origin: "desktop",
      thread: [],
      createdAt: "2026-09-03T19:00:00.000Z",
      updatedAt: "2026-09-03T19:00:00.000Z",
    })
    const context = await startedDaemon(snapshot)
    const response = await context.rpc("plan.edit", {
      sessionId: session.id,
      basedOnStructureRevision: 1,
      baseSteps: [{ id: "step-existing", text: "Inspect" }],
      draftSteps: [
        { id: "step-existing", text: "Inspect carefully" },
        { text: "Run TOKEN=client-plan-secret" },
      ],
      client: "desktop",
    })

    expect(response).not.toHaveProperty("error")
    expect(response.result.receipt).toMatchObject({
      disposition: "applied",
      client: "desktop",
      clientId: "desktop-plan-test",
      connectionId: context.connectionId,
      basedOnStructureRevision: 1,
      structureRevision: 2,
    })
    const plan = response.result.snapshot.workingPlans.find(
      (candidate) => candidate.sessionId === session.id,
    )!
    expect(plan.steps).toEqual([
      { id: "step-existing", text: "Inspect carefully", status: "completed" },
      expect.objectContaining({ text: "Run TOKEN=[REDACTED]", status: "pending" }),
    ])
    const artifact = response.result.snapshot.artifacts.find(
      (candidate) => candidate.id === `plan-${session.id}`,
    )!
    expect(artifact.content).toContain("Run TOKEN=[REDACTED]")
    expect(artifact.content).not.toMatch(/completed|pending/)
    expect(response.result.snapshot.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "annotation-working-plan",
        artifactId: `plan-${session.id}`,
      }),
    ]))
    expect(JSON.stringify(context.durable())).not.toContain("client-plan-secret")
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: {
        kind: "client",
        client: "desktop",
        clientId: "desktop-plan-test",
        connectionId: context.connectionId,
      },
      action: "plan.edit",
      target: response.result.receipt.editId,
      detail: expect.stringContaining("disposition=applied"),
    }))
    expect(JSON.stringify(context.audit.mock.calls)).not.toContain("client-plan-secret")
    context.socket.close()
  })

  it("keeps a first edit queued while waiting and discards only by its id", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[1]!
    session.state = "waiting"
    snapshot.workingPlans = snapshot.workingPlans.filter((plan) => plan.sessionId !== session.id)
    const context = await startedDaemon(snapshot)
    const queued = await context.rpc("plan.edit", {
      sessionId: session.id,
      basedOnStructureRevision: 0,
      baseSteps: [],
      draftSteps: [{ text: "Inspect the empty state" }],
      client: "desktop",
    })

    expect(queued.result.receipt.disposition).toBe("queued")
    expect(queued.result.snapshot.workingPlans.find(
      (plan) => plan.sessionId === session.id,
    )).toMatchObject({
      structureRevision: 0,
      steps: [],
      pendingEdit: {
        id: queued.result.receipt.editId,
        status: "queued",
        draftSteps: [expect.objectContaining({ text: "Inspect the empty state" })],
      },
    })

    const discarded = await context.rpc("plan.discardEdit", {
      sessionId: session.id,
      editId: queued.result.receipt.editId,
      client: "desktop",
    })
    expect(discarded.result.receipt.disposition).toBe("discarded")
    expect(discarded.result.snapshot.workingPlans.find(
      (plan) => plan.sessionId === session.id,
    )?.pendingEdit).toBeUndefined()
    context.socket.close()
  })

  it("keeps a queued draft conflicted when the provider restructures the plan", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.workspacePath = "/worktrees/provider-plan-test"
    session.providerThreadId = "thread-provider-plan"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.workingPlans = [{
      sessionId: session.id,
      revision: 1,
      structureRevision: 1,
      steps: [
        { id: "step-inspect", text: "Inspect", status: "in-progress" },
        { id: "step-implement", text: "Implement", status: "pending" },
      ],
      providerSync: {
        provider: "claude-code",
        model: "sonnet-4.6",
        providerThreadId: "thread-provider-plan",
        structureRevision: 1,
        deliveredAt: "2026-09-03T19:00:00.000Z",
      },
      createdAt: "2026-09-03T19:00:00.000Z",
      updatedAt: "2026-09-03T19:00:00.000Z",
    }]
    snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.sessionId !== session.id)
    snapshot.annotations = snapshot.annotations.filter(
      (annotation) => annotation.sessionId !== session.id,
    )
    snapshot.artifacts.push({
      id: `plan-${session.id}`,
      sessionId: session.id,
      title: "Working plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content: "# Working plan\n\n1. Inspect\n2. Implement\n",
    })
    let emit: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-provider-plan"),
      steerTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        emit = listener
        return () => { emit = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const context = await startedDaemon(snapshot, { "claude-code": agent })
    const started = await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue with the plan",
      client: "desktop",
    })
    expect(started).not.toHaveProperty("error")
    expect(agent.startTurn).toHaveBeenCalledOnce()
    const queued = await context.rpc("plan.edit", {
      sessionId: session.id,
      basedOnStructureRevision: 1,
      baseSteps: [
        { id: "step-inspect", text: "Inspect" },
        { id: "step-implement", text: "Implement" },
      ],
      draftSteps: [
        { id: "step-implement", text: "Implement carefully" },
        { id: "step-inspect", text: "Inspect" },
      ],
      client: "desktop",
    })
    expect(queued.result.receipt.disposition).toBe("queued")

    emit!({
      type: "plan-updated",
      threadId: "thread-provider-plan",
      turnId: "turn-provider-plan",
      steps: [
        { text: "Inspect", status: "completed" },
        { text: "Run TOKEN=provider-plan-secret", status: "in-progress" },
      ],
    })

    await waitForDaemon(() => expect(context.durable().workingPlans[0]).toMatchObject({
      revision: 3,
      structureRevision: 2,
      steps: [
        { id: "step-inspect", text: "Inspect", status: "completed" },
        expect.objectContaining({ text: "Run TOKEN=[REDACTED]", status: "in-progress" }),
      ],
      providerSync: {
        provider: "claude-code",
        model: "sonnet-4.6",
        providerThreadId: "thread-provider-plan",
        structureRevision: 2,
        deliveredAt: expect.any(String),
      },
      pendingEdit: expect.objectContaining({
        id: queued.result.receipt.editId,
        status: "conflicted",
        draftSteps: [
          { id: "step-implement", text: "Implement carefully" },
          { id: "step-inspect", text: "Inspect" },
        ],
      }),
    }))
    const artifact = context.durable().artifacts.find(
      (candidate) => candidate.id === `plan-${session.id}`,
    )!
    expect(artifact).toMatchObject({
      revision: 2,
      content: "# Working plan\n\n1. Inspect\n2. Run TOKEN=[REDACTED]\n",
    })
    expect(JSON.stringify(context.durable())).not.toContain("provider-plan-secret")
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: {
        kind: "provider",
        provider: "claude-code",
        providerThreadId: "thread-provider-plan",
      },
      action: "provider.plan-updated",
      target: session.id,
      detail: expect.stringContaining("structure=2"),
    }))
    expect(JSON.stringify(context.audit.mock.calls)).not.toContain("provider-plan-secret")

    emit!({
      type: "approval-requested",
      requestId: 42,
      threadId: "thread-provider-plan",
      turnId: "turn-provider-plan",
      itemId: "tool-provider-plan",
      command: "git push origin main",
      reason: "Publish the completed change",
    })
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    const approvalId = context.durable().approvals[0]!.id
    expect(context.durable().workingPlans[0]!.steps[1]!.blocker).toEqual({
      kind: "approval",
      approvalId,
    })

    const resolved = await context.rpc("approval.resolve", {
      approvalId,
      decision: "deny",
      client: "desktop",
    })
    expect(resolved).not.toHaveProperty("error")
    expect(resolved.result.workingPlans[0]!.steps[1]!.blocker).toBeUndefined()
    expect(agent.resolveApproval).toHaveBeenCalledWith(42, "deny")

    emit!({
      type: "plan-updated",
      threadId: "thread-provider-plan",
      turnId: "turn-provider-plan",
      steps: [
        { text: "Inspect", status: "completed" },
        { text: "Run TOKEN=provider-plan-secret", status: "completed" },
      ],
    })
    await waitForDaemon(() => expect(context.durable().workingPlans[0]).toMatchObject({
      revision: 6,
      structureRevision: 2,
      steps: [
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "completed" }),
      ],
    }))
    expect(context.durable().artifacts.find(
      (candidate) => candidate.id === `plan-${session.id}`,
    )?.revision).toBe(2)

    const savesBeforeLegacyDelta = context.save.mock.calls.length
    emit!({
      type: "plan-delta",
      threadId: "thread-provider-plan",
      turnId: "turn-provider-plan",
      delta: "This opaque plan must not replace canonical steps.",
    })
    await waitForDaemon(() => expect(context.save).toHaveBeenCalledTimes(savesBeforeLegacyDelta + 1))
    expect(context.durable().artifacts.find(
      (candidate) => candidate.id === `plan-${session.id}`,
    )).toMatchObject({
      revision: 2,
      content: "# Working plan\n\n1. Inspect\n2. Run TOKEN=[REDACTED]\n",
    })
    context.socket.close()
  })

  it("applies and delivers a queued edit only after the next turn starts", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.workspacePath = "/worktrees/plan-boundary"
    session.providerThreadId = "thread-plan-boundary"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.workingPlans = [{
      sessionId: session.id,
      revision: 2,
      structureRevision: 1,
      steps: [
        { id: "step-inspect", text: "Inspect", status: "completed" },
        { id: "step-implement", text: "Implement", status: "pending" },
      ],
      providerSync: {
        provider: "claude-code",
        model: "sonnet-4.6",
        providerThreadId: "thread-plan-boundary",
        structureRevision: 1,
        deliveredAt: "2026-09-03T19:00:00.000Z",
      },
      pendingEdit: {
        id: "edit-plan-boundary",
        basedOnStructureRevision: 1,
        baseSteps: [
          { id: "step-inspect", text: "Inspect" },
          { id: "step-implement", text: "Implement" },
        ],
        draftSteps: [
          { id: "step-inspect", text: "Inspect" },
          { id: "step-implement", text: "Implement carefully" },
        ],
        status: "queued",
        submittedAt: "2026-09-03T19:30:00.000Z",
        submittedBy: {
          client: "desktop",
          clientId: "desktop-plan-author",
          connectionId: "11111111-1111-4111-8111-111111111111",
        },
      },
      createdAt: "2026-09-03T19:00:00.000Z",
      updatedAt: "2026-09-03T19:30:00.000Z",
    }]
    snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.sessionId !== session.id)
    snapshot.annotations = snapshot.annotations.filter(
      (annotation) => annotation.sessionId !== session.id,
    )
    snapshot.artifacts.push({
      id: `plan-${session.id}`,
      sessionId: session.id,
      title: "Working plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content: "# Working plan\n\n1. Inspect\n2. Implement\n",
    })
    const startTurn = vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => (
      "turn-plan-boundary"
    ))
    startTurn.mockRejectedValueOnce(new Error("provider rejected the turn"))
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      startTurn,
      steerTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const context = await startedDaemon(snapshot, { "claude-code": agent })

    const refused = await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue",
      client: "desktop",
    })
    expect(refused).toMatchObject({ error: { code: -32603 } })
    expect(context.durable().workingPlans[0]).toMatchObject({
      revision: 2,
      structureRevision: 1,
      pendingEdit: { id: "edit-plan-boundary", status: "queued" },
    })
    expect(context.durable().artifacts.find(
      (artifact) => artifact.id === `plan-${session.id}`,
    )?.revision).toBe(1)

    const response = await context.rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue",
      client: "desktop",
    })

    expect(response).not.toHaveProperty("error")
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-plan-boundary",
      prompt: expect.stringContaining('"text":"Implement carefully"'),
    }))
    const sentPrompt = agent.startTurn.mock.calls[1]![0].prompt
    expect(sentPrompt).toContain("<domovoi_working_plan>")
    expect(sentPrompt).not.toContain('"draftSteps"')
    expect(sentPrompt).toContain("Continue")
    expect(response.result.workingPlans[0]).toMatchObject({
      revision: 4,
      structureRevision: 2,
      steps: [
        { id: "step-inspect", text: "Inspect", status: "completed" },
        { id: "step-implement", text: "Implement carefully", status: "pending" },
      ],
      providerSync: {
        provider: "claude-code",
        model: "sonnet-4.6",
        providerThreadId: "thread-plan-boundary",
        structureRevision: 2,
        deliveredAt: expect.any(String),
      },
    })
    expect(response.result.workingPlans[0]).not.toHaveProperty("pendingEdit")
    expect(response.result.artifacts.find(
      (artifact) => artifact.id === `plan-${session.id}`,
    )).toMatchObject({
      revision: 2,
      content: "# Working plan\n\n1. Inspect\n2. Implement carefully\n",
    })
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: {
        kind: "client",
        client: "desktop",
        clientId: "desktop-plan-author",
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
      action: "plan.edit-finalized",
      outcome: "succeeded",
      target: "edit-plan-boundary",
      detail: expect.stringContaining("structure=2"),
    }))
    context.socket.close()
  })
})
