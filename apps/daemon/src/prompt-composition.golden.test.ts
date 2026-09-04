// Characterization goldens for the prompt the daemon hands a provider.
//
// There is no composer today: the session.send handler assembles five layers in
// place. These tests drive session.send and capture the prompt given to
// agent.startTurn, so they describe behaviour rather than structure and survive
// the extraction of a composer unchanged.
//
// They exist to make that extraction provably byte-identical. Do not run vitest
// with -u against this file while the composer is being written: an updated
// snapshot is the failure these tests are here to catch.
import WebSocket from "ws"
import { afterEach, expect, it } from "vitest"

import {
  demoWorkspace,
  protocolVersion,
  type RpcMethod,
  type RpcResult,
  type SkillEnablementReview,
  type SkillSummary,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { AuditLog } from "./audit-log.js"
import { DomovoiDaemon } from "./server.js"
import type { SkillCatalog } from "./skills.js"
import type { WorkspaceStore } from "./store.js"

const running: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

const fixedDigest = `sha256:${"a".repeat(64)}` as const

const skillSummary: SkillSummary = {
  id: "skill-aaaaaaaaaaaa",
  name: "replay-audit",
  description: "replay-audit instructions",
  path: "/skills/replay-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: ["filesystem.read"] },
  contentDigest: fixedDigest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
}

function enablement(projectId: string): SkillEnablementReview {
  return {
    projectId,
    skillId: skillSummary.id,
    enabled: true,
    contentDigest: skillSummary.contentDigest,
    manifest: skillSummary.manifest,
    reviewedAt: "2026-08-30T00:00:00.000Z",
    reviewedBy: { client: "desktop", clientId: "reviewer" },
  }
}

const skillCatalog: SkillCatalog = {
  list: async () => [skillSummary],
  read: async () => ({ skill: skillSummary, content: "Check every replay path." }),
}

type Sections = {
  handoff: boolean
  plan: boolean
  annotations: boolean
  skills: boolean
}

function snapshotFor(sections: Sections) {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  const project = snapshot.project!
  session.state = "idle"
  session.workspacePath = "/worktrees/golden"
  session.providerThreadId = "thread-golden"
  delete session.activeTurnId
  snapshot.approvals = []
  snapshot.annotations = []
  snapshot.workingPlans = []
  snapshot.skillEnablements = []
  snapshot.thread = snapshot.thread.filter((item) => item.kind !== "system")

  if (sections.handoff) {
    snapshot.thread.push({
      id: "handoff-golden",
      sessionId: session.id,
      kind: "system",
      body: "Handed off codex / gpt-5.3-codex to claude-code / sonnet-4.6 at a turn boundary.",
      createdAt: "2026-09-03T18:00:00.000Z",
    })
  }

  if (sections.plan) {
    snapshot.workingPlans = [{
      sessionId: session.id,
      revision: 2,
      structureRevision: 2,
      steps: [
        { id: "step-one", text: "Add a replay table", status: "completed" },
        { id: "step-two", text: "Replay a duplicate delivery", status: "pending" },
      ],
      createdAt: "2026-09-03T17:00:00.000Z",
      updatedAt: "2026-09-03T17:30:00.000Z",
    }]
  }

  if (sections.annotations) {
    const demo = structuredClone(demoWorkspace).annotations
      .filter((annotation) => annotation.status === "open")
      .slice(0, 1)
      .map((annotation) => ({ ...annotation, sessionId: session.id }))
    snapshot.annotations = demo
  }

  if (sections.skills) {
    snapshot.skillEnablements = [enablement(project.id)]
  }

  return snapshot
}

type PromptRunOptions = {
  prompt?: string
  mutateSnapshot?: (snapshot: ReturnType<typeof snapshotFor>) => void
}

async function sendFor(sections: Sections, options: PromptRunOptions = {}) {
  const snapshot = snapshotFor(sections)
  options.mutateSnapshot?.(snapshot)
  const initial = structuredClone(snapshot)
  let durable = structuredClone(snapshot)
  const store = {
    load: () => structuredClone(durable),
    save: (next: typeof snapshot) => { durable = structuredClone(next) },
    close: () => {},
  } satisfies WorkspaceStore
  const auditLog = {
    append: (input: Parameters<AuditLog["append"]>[0]) => ({
      id: "audit-golden",
      occurredAt: "2026-09-03T20:00:00.000Z",
      ...input,
    }),
    query: () => ({ entries: [], hasMore: false }),
    export: () => ({
      format: "jsonl" as const,
      exportedAt: "2026-09-03T20:00:00.000Z",
      content: "",
      entryCount: 0,
      hasMore: false,
    }),
  } satisfies AuditLog

  const prompts: string[] = []
  const agent = {
    connect: async () => {},
    listModels: async () => [],
    startThread: async () => "thread-golden",
    resumeThread: async () => {},
    stopThread: async () => {},
    interruptTurn: async () => {},
    startTurn: async (input: Parameters<AgentAdapter["startTurn"]>[0]) => {
      prompts.push(input.prompt)
      return "turn-golden"
    },
    steerTurn: async () => {},
    resolveApproval: () => {},
    onEvent: (_listener: (event: AgentEvent) => void) => () => {},
    close: async () => {},
  } satisfies AgentAdapter

  const daemon = new DomovoiDaemon({
    port: 0,
    store,
    agents: { [snapshot.sessions[0]!.runtime.provider]: agent },
    auditLog,
    skillCatalog,
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
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown> & { result: RpcResult<M> })
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  await rpc("system.hello", {
    client: "desktop",
    clientId: "desktop-golden",
    clientVersion: "0.0.1",
    protocolVersion,
  })
  const sent = await rpc("session.send", {
    sessionId: snapshot.sessions[0]!.id,
    prompt: options.prompt ?? "Replay the duplicate delivery and report what changed.",
    client: "desktop",
  })
  socket.close()
  return { durable, initial, prompts, sent }
}

async function promptFor(sections: Sections): Promise<string> {
  const { prompts, sent } = await sendFor(sections)
  expect(sent).not.toHaveProperty("error")
  expect(prompts).toHaveLength(1)
  return prompts[0]!
}

const combinations: Sections[] = Array.from({ length: 16 }, (_, mask) => ({
  handoff: Boolean(mask & 1),
  plan: Boolean(mask & 2),
  annotations: Boolean(mask & 4),
  skills: Boolean(mask & 8),
}))

function label(sections: Sections): string {
  const present = Object.entries(sections)
    .filter(([, on]) => on)
    .map(([name]) => name)
  return present.length ? present.join("+") : "user text only"
}

for (const sections of combinations) {
  it(`composes ${label(sections)} exactly as it does today`, async () => {
    expect(await promptFor(sections)).toMatchSnapshot()
  })
}

it("keeps the outer-to-inner order the call site produces", async () => {
  const prompt = await promptFor({ handoff: true, plan: true, annotations: true, skills: true })
  const order = [
    prompt.indexOf("domovoi_skill_context"),
    prompt.indexOf("domovoi_review_context"),
    prompt.indexOf("domovoi_working_plan"),
    prompt.indexOf("domovoi_handoff_context"),
    prompt.indexOf("Replay the duplicate delivery"),
  ]
  expect(order.every((position) => position >= 0)).toBe(true)
  expect([...order].sort((left, right) => left - right)).toEqual(order)
})

it("persists exact delivery facts only after the provider accepts a turn", async () => {
  const { durable, prompts, sent } = await sendFor({
    handoff: true,
    plan: true,
    annotations: true,
    skills: true,
  })

  expect(sent).not.toHaveProperty("error")
  const userItem = durable.thread.findLast((item) => item.kind === "user")
  expect(userItem).toMatchObject({
    providerPromptDelivery: {
      version: 1,
      budget: {
        unit: "utf16-code-units",
        limit: 262_144,
        used: prompts[0]!.length,
      },
      handoff: { status: "delivered" },
      workingPlan: { status: "delivered", structureRevision: 2 },
      annotations: { availableCount: 1 },
      skills: {
        selection: "project-default",
        delivered: [expect.objectContaining({ id: skillSummary.id })],
      },
    },
  })
})

it("persists nothing when required context exceeds the payload limit", async () => {
  const { durable, initial, prompts, sent } = await sendFor(
    { handoff: false, plan: true, annotations: false, skills: false },
    {
      prompt: "u".repeat(205_000),
      mutateSnapshot: (snapshot) => {
        snapshot.workingPlans[0]!.steps = Array.from({ length: 15 }, (_, index) => ({
          id: `step-${index}`,
          text: "p".repeat(4_000),
          status: "pending",
        }))
      },
    },
  )

  expect(sent).toMatchObject({
    error: {
      code: -32602,
      message: expect.stringMatching(/working plan.+262144 UTF-16 code units/i),
    },
  })
  expect(prompts).toEqual([])
  expect(durable.thread).toEqual(initial.thread)
  expect(durable.workingPlans).toEqual(initial.workingPlans)
})
