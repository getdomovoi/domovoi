import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type Annotation,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

// Rulings Q348 A and Q342 A: preview comments reach the agent only when a
// person sends them with a message, and the variant they chose as the build
// basis travels with that send. A half-written comment no longer steers a turn.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const sessionId = "session-billing"

function comment(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    ...structuredClone(demoWorkspace.annotations[1]!),
    id,
    sessionId,
    artifactId: "artifact-preview-a",
    body: `Body of ${id}`,
    status: "open",
    thread: [],
    createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T12:00:00.000Z",
    ...overrides,
  }
}

function reviewWorkspace(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  snapshot.approvals = []
  const preview = (id: string, label: string, order: number) => ({
    id, sessionId, title: `Checkout ${label}`, type: "preview" as const, revision: 1,
    path: `.domovoi/previews/${id}.html`, mimeType: "text/html",
    variant: { id: `variant-${label.toLowerCase()}`, groupId: "checkout", label, order },
  })
  snapshot.artifacts = [
    ...snapshot.artifacts.filter((artifact) => artifact.sessionId !== sessionId || artifact.type !== "preview"),
    preview("artifact-preview-a", "A", 0),
    preview("artifact-preview-b", "B", 1),
    { ...preview("artifact-preview-elsewhere", "C", 0), sessionId: "session-onboarding" },
  ]
  snapshot.annotations = [
    comment("comment-ready", { updatedAt: "2026-09-30T12:01:00.000Z" }),
    comment("comment-half-written", { body: "maybe make the", updatedAt: "2026-09-30T12:02:00.000Z" }),
    comment("comment-older", { updatedAt: "2026-09-30T11:00:00.000Z" }),
    comment("comment-resolved", { status: "resolved" }),
    comment("comment-elsewhere", { sessionId: "session-onboarding", artifactId: "artifact-preview-elsewhere" }),
  ]
  return workspaceSnapshotSchema.parse(snapshot)
}

async function start() {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn<(input: Parameters<AgentAdapter["startTurn"]>[0]) => Promise<string>>()
      .mockResolvedValueOnce("turn-1").mockResolvedValueOnce("turn-2").mockResolvedValue("turn-3"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const daemon = new DomovoiDaemon({
    port: 0, store: new SqliteWorkspaceStore(":memory:", reviewWorkspace()),
    agents: { codex: provider }, errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message as Record<string, unknown>)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<{ result?: unknown, error?: { code: number, message: string } }>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve as (message: Record<string, unknown>) => void)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await rpc("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
  const snapshot = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  const send = (prompt: string, extra: Record<string, unknown> = {}) => rpc("session.send", { sessionId, prompt, client: "desktop", ...extra })
  const lastUserItem = async () => (await snapshot()).thread.findLast((item) => item.kind === "user" && item.sessionId === sessionId)
  return { provider, rpc, send, snapshot, lastUserItem, emit: (event: AgentEvent) => emit(event) }
}

function reviewContext(prompt: string): { unresolvedAnnotations: Array<{ annotationId: string, comment: { body: string } }>, buildBasis?: unknown } | undefined {
  const match = /<domovoi_review_context>\n(.+)\n<\/domovoi_review_context>/.exec(prompt)
  return match ? JSON.parse(match[1]!) : undefined
}

describe("a message with no review", () => {
  // Ruling Q402: until every client sends `review`, a message without one
  // keeps the behaviour clients were built against: every open comment of the
  // session attaches, and no build basis. Removed before 0.8.0 ships.
  it("still attaches every open comment of its session, and no build basis", async () => {
    const { provider, send, lastUserItem } = await start()
    expect((await send("Carry on")).error).toBeUndefined()
    const context = reviewContext(provider.startTurn.mock.calls[0]![0].prompt)
    expect(context?.unresolvedAnnotations.map((item) => item.annotationId))
      .toEqual(["comment-half-written", "comment-ready", "comment-older"])
    expect(context).not.toHaveProperty("buildBasis")
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }).providerPromptDelivery?.annotations).toEqual({
      availableCount: 3, deliveredIds: ["comment-half-written", "comment-ready", "comment-older"], omitted: { budget: 0, limit: 0 },
    })
  })

  it("is the only path that attaches a comment the message did not name", async () => {
    const { provider, send } = await start()
    expect((await send("Only this", { review: { annotationIds: ["comment-older"] } })).error).toBeUndefined()
    expect(reviewContext(provider.startTurn.mock.calls[0]![0].prompt)?.unresolvedAnnotations.map((item) => item.annotationId))
      .toEqual(["comment-older"])
  })
})

describe("a message that sends comments", () => {
  it("delivers only the comments it names, newest first, and records them", async () => {
    const { provider, send, lastUserItem } = await start()
    expect((await send("Address these", { review: { annotationIds: ["comment-older", "comment-ready"] } })).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    expect(reviewContext(prompt)?.unresolvedAnnotations.map((item) => item.annotationId)).toEqual(["comment-ready", "comment-older"])
    expect(prompt).not.toContain("comment-half-written")
    expect(prompt).not.toContain("maybe make the")
    expect(reviewContext(prompt)).not.toHaveProperty("buildBasis")
    const delivery = (await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }
    expect(delivery.providerPromptDelivery?.annotations).toEqual({
      availableCount: 2, deliveredIds: ["comment-ready", "comment-older"], omitted: { budget: 0, limit: 0 },
    })
  })

  it.each([
    ["a resolved comment", "comment-resolved"],
    ["another session's comment", "comment-elsewhere"],
    ["a comment that does not exist", "comment-missing"],
  ])("refuses %s, and nothing is sent", async (_label, annotationId) => {
    const { provider, send, snapshot } = await start()
    const before = (await snapshot()).thread.length
    const refused = await send("Address these", { review: { annotationIds: ["comment-ready", annotationId] } })
    expect(refused.error?.message).toBe("A comment sent with this message is not open on this session, so the message was not sent. Send it again without that comment.")
    expect(provider.startTurn).not.toHaveBeenCalled()
    expect((await snapshot()).thread).toHaveLength(before)
  })
})

describe("a message that sends a build basis", () => {
  it("tells the agent which variant to build on, and records it", async () => {
    const { provider, send, lastUserItem } = await start()
    expect((await send("Build it", { review: { annotationIds: ["comment-ready"], buildBasis: { artifactId: "artifact-preview-b" } } })).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    expect(reviewContext(prompt)?.buildBasis).toEqual({
      artifactId: "artifact-preview-b",
      artifactTitle: "Checkout B",
      artifactRevision: 1,
      variant: { id: "variant-b", groupId: "checkout", label: "B" },
    })
    expect(prompt).toContain("The person chose the preview in buildBasis as the build basis. Build on that variant.")
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }).providerPromptDelivery?.annotations).toEqual({
      availableCount: 1, deliveredIds: ["comment-ready"], omitted: { budget: 0, limit: 0 }, buildBasis: { artifactId: "artifact-preview-b" },
    })
  })

  it("can be sent without a comment", async () => {
    const { provider, send } = await start()
    expect((await send("Build it", { review: { annotationIds: [], buildBasis: { artifactId: "artifact-preview-a" } } })).error).toBeUndefined()
    const context = reviewContext(provider.startTurn.mock.calls[0]![0].prompt)
    expect(context?.unresolvedAnnotations).toEqual([])
    expect(context?.buildBasis).toMatchObject({ artifactId: "artifact-preview-a", variant: { label: "A" } })
  })

  it.each([
    ["a plan", "artifact-plan"],
    ["another session's preview", "artifact-preview-elsewhere"],
    ["an artifact that does not exist", "artifact-missing"],
  ])("refuses %s as a build basis", async (_label, artifactId) => {
    const { provider, send } = await start()
    const refused = await send("Build it", { review: { annotationIds: [], buildBasis: { artifactId } } })
    expect(refused.error?.message).toBe("The build basis sent with this message is not a preview of this session, so the message was not sent.")
    expect(provider.startTurn).not.toHaveBeenCalled()
  })
})

describe("a queued message", () => {
  it("keeps its review until the turn it waits for ends, and refuses a bad one up front", async () => {
    const { provider, send, emit } = await start()
    expect((await send("First")).error).toBeUndefined()
    expect((await send("Next", { delivery: "next-turn-replace", review: { annotationIds: ["comment-missing"] } })).error?.message)
      .toBe("A comment sent with this message is not open on this session, so the message was not sent. Send it again without that comment.")
    expect((await send("Next", { delivery: "next-turn-replace", review: { annotationIds: ["comment-ready"], buildBasis: { artifactId: "artifact-preview-b" } } })).error).toBeUndefined()

    emit({ type: "turn-completed", params: { threadId: "thread-billing", turn: { id: "turn-1", status: "completed" } } })
    await waitForDaemon(() => expect(provider.startTurn).toHaveBeenCalledTimes(2))
    const released = reviewContext(provider.startTurn.mock.calls[1]![0].prompt)
    expect(released?.unresolvedAnnotations.map((item) => item.annotationId)).toEqual(["comment-ready"])
    expect(released?.buildBasis).toMatchObject({ artifactId: "artifact-preview-b" })
  })
})
