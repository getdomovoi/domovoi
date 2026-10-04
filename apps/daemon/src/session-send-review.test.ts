import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  demoWorkspace,
  maximumReviewAnnotations,
  openCommentReviewFor,
  protocolVersion,
  workspaceSnapshotSchema,
  type Annotation,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

// Rulings Q348 A and Q342 A: a message that carries a review sends only the
// comments it names, and the variant chosen as the build basis travels with
// it, so a half-written comment no longer steers that turn. Ruling Q402: a
// message without a review sends no comment and no build basis; the legacy
// default that attached every open comment of its session is gone.

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

function reviewWorkspace(extraAnnotations: Annotation[] = []): WorkspaceSnapshot {
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
    { id: "artifact-preview-lone", sessionId, title: "Checkout alone", type: "preview" as const, revision: 1, path: ".domovoi/previews/lone.html", mimeType: "text/html" },
    { ...preview("artifact-preview-elsewhere", "C", 0), sessionId: "session-onboarding" },
  ]
  snapshot.annotations = [
    comment("comment-ready", { updatedAt: "2026-09-30T12:01:00.000Z" }),
    comment("comment-half-written", { body: "maybe make the", updatedAt: "2026-09-30T12:02:00.000Z" }),
    comment("comment-older", { updatedAt: "2026-09-30T11:00:00.000Z" }),
    comment("comment-resolved", { status: "resolved" }),
    comment("comment-elsewhere", { sessionId: "session-onboarding", artifactId: "artifact-preview-elsewhere" }),
    ...extraAnnotations,
  ]
  return workspaceSnapshotSchema.parse(snapshot)
}

async function start(extraAnnotations: Annotation[] = []) {
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
    port: 0, store: new SqliteWorkspaceStore(":memory:", reviewWorkspace(extraAnnotations)),
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

function reviewContext(prompt: string): { unresolvedAnnotations: Array<{ annotationId: string, comment: { body: string } }>, omittedAnnotationCount?: number, buildBasis?: unknown } | undefined {
  const match = /<domovoi_review_context>\n(.+)\n<\/domovoi_review_context>/.exec(prompt)
  return match ? JSON.parse(match[1]!) : undefined
}

describe("a message with no review", () => {
  // Ruling Q402: a message without a review sends no comment and no build
  // basis, while three comments are open on the session. The legacy default
  // that attached every open comment is gone; nothing attaches a comment the
  // message did not name.
  it("sends no comment and no build basis while open ones exist", async () => {
    const { provider, send, snapshot, lastUserItem } = await start()
    expect((await snapshot()).annotations.filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")).toHaveLength(3)
    expect((await send("Carry on")).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    expect(reviewContext(prompt)).toBeUndefined()
    expect(prompt).not.toContain("comment-half-written")
    expect(prompt).not.toContain("maybe make the")
    expect(prompt).not.toContain("buildBasis")
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }).providerPromptDelivery?.annotations).toEqual({
      availableCount: 0, deliveredIds: [], omitted: { budget: 0, limit: 0 },
    })
  })

  it("is read the same as an empty review", async () => {
    const unreviewed = await start()
    expect((await unreviewed.send("Carry on")).error).toBeUndefined()
    const explicit = await start()
    expect((await explicit.send("Carry on", { review: { annotationIds: [] } })).error).toBeUndefined()
    expect(unreviewed.provider.startTurn.mock.calls[0]![0].prompt).toBe(explicit.provider.startTurn.mock.calls[0]![0].prompt)
  })

  it("delivers only what a review names, never the rest", async () => {
    const { provider, send } = await start()
    expect((await send("Only this", { review: { annotationIds: ["comment-older"] } })).error).toBeUndefined()
    expect(reviewContext(provider.startTurn.mock.calls[0]![0].prompt)?.unresolvedAnnotations.map((item) => item.annotationId))
      .toEqual(["comment-older"])
  })
})

describe("a message with an empty review", () => {
  it("sends no comment while open ones exist", async () => {
    const { provider, send, lastUserItem } = await start()
    expect((await send("Carry on", { review: { annotationIds: [] } })).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    expect(reviewContext(prompt)).toBeUndefined()
    expect(prompt).not.toContain("maybe make the")
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }).providerPromptDelivery?.annotations).toEqual({
      availableCount: 0, deliveredIds: [], omitted: { budget: 0, limit: 0 },
    })
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

// Codex review of PR #717: a client names at most the newest
// `maximumReviewAnnotations` open comments. The older ones it left out are
// counted on the review, and the daemon records that count as the turn's limit
// omission, so the desktop and web note shows them. The count never selects:
// the daemon composes only the comments the review names.
describe("a full message that left open comments over the limit", () => {
  // The fixture's three open comments plus `count` newer ones.
  function withOpenComments(count: number) {
    return start(Array.from({ length: count }, (_, index) => comment(
      `comment-many-${String(index).padStart(2, "0")}`,
      { updatedAt: `2026-09-30T13:${String(index).padStart(2, "0")}:00.000Z` },
    )))
  }

  it("records the count as the limit omission and sends only the named comments", async () => {
    const { provider, send, snapshot, lastUserItem } = await withOpenComments(maximumReviewAnnotations - 2)
    const current = await snapshot()
    const open = current.annotations.filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
    expect(open).toHaveLength(maximumReviewAnnotations + 1)
    const review = openCommentReviewFor(current, sessionId)
    expect(review.annotationIds).toHaveLength(maximumReviewAnnotations)
    expect(review.omittedOverLimit).toBe(1)
    const oldest = open.find((annotation) => !review.annotationIds.includes(annotation.id))!
    expect(oldest.id).toBe("comment-older")

    expect((await send("Address these", { review })).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    const context = reviewContext(prompt)
    expect(context?.unresolvedAnnotations.map((item) => item.annotationId).sort()).toEqual([...review.annotationIds].sort())
    expect(context?.omittedAnnotationCount).toBe(1)
    expect(prompt).not.toContain(oldest.id)
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: unknown } }).providerPromptDelivery?.annotations).toMatchObject({
      availableCount: maximumReviewAnnotations + 1,
      omitted: { budget: 0, limit: 1 },
    })
  })

  it("never sends a comment for the count, whatever count the client reports", async () => {
    const { provider, send, snapshot, lastUserItem } = await withOpenComments(maximumReviewAnnotations - 2)
    const review = openCommentReviewFor(await snapshot(), sessionId)
    expect((await send("Address these", { review: { ...review, omittedOverLimit: 7 } })).error).toBeUndefined()
    const context = reviewContext(provider.startTurn.mock.calls[0]![0].prompt)
    expect(context?.unresolvedAnnotations.map((item) => item.annotationId).sort()).toEqual([...review.annotationIds].sort())
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: { omitted: unknown } } }).providerPromptDelivery?.annotations.omitted)
      .toEqual({ budget: 0, limit: 7 })
  })

  // History reads the count from the same record (Q431), so its row says
  // what the thread says beside the message.
  it("carries the reported count to the message's history entry", async () => {
    const { send, snapshot, rpc } = await withOpenComments(maximumReviewAnnotations - 2)
    const review = openCommentReviewFor(await snapshot(), sessionId)
    expect((await send("Address these", { review: { ...review, omittedOverLimit: 7 } })).error).toBeUndefined()
    const page = (await rpc("session.history", { sessionId, categories: ["messages"] })).result as { items: Array<{ role?: string; body?: string; annotationsOverLimit?: number }> }
    expect(page.items.find((item) => item.role === "user" && item.body === "Address these")).toMatchObject({ annotationsOverLimit: 7 })
  })

  it("keeps the count on a queued message until it is released", async () => {
    const { provider, send, snapshot, lastUserItem, emit } = await withOpenComments(maximumReviewAnnotations - 2)
    const review = openCommentReviewFor(await snapshot(), sessionId)
    expect((await send("First", { review: { annotationIds: [] } })).error).toBeUndefined()
    expect((await send("Next", { delivery: "next-turn-replace", review })).error).toBeUndefined()

    emit({ type: "turn-completed", params: { threadId: "thread-billing", turn: { id: "turn-1", status: "completed" } } })
    await waitForDaemon(() => expect(provider.startTurn).toHaveBeenCalledTimes(2))
    await waitForDaemon(async () => expect(((await lastUserItem()) as { body?: string } | undefined)?.body).toBe("Next"))
    expect(((await lastUserItem()) as { providerPromptDelivery?: { annotations: { omitted: unknown } } }).providerPromptDelivery?.annotations.omitted)
      .toEqual({ budget: 0, limit: 1 })
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
    expect(prompt).toContain("The person chose the preview in buildBasis as the build basis. Build on that preview.")
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

  it("can be a lone render with no variants, and the agent is told to build on that preview", async () => {
    const { provider, send } = await start()
    expect((await send("Build it", { review: { annotationIds: [], buildBasis: { artifactId: "artifact-preview-lone" } } })).error).toBeUndefined()
    const prompt = provider.startTurn.mock.calls[0]![0].prompt
    expect(reviewContext(prompt)?.buildBasis).toEqual({ artifactId: "artifact-preview-lone", artifactTitle: "Checkout alone", artifactRevision: 1 })
    expect(prompt).toContain("Build on that preview.")
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

  it("is refused at release when a comment it names closed while it waited, and the provider is not called", async () => {
    const { provider, rpc, send, snapshot, emit } = await start()
    expect((await send("First")).error).toBeUndefined()
    expect((await send("Next", { delivery: "next-turn-replace", review: { annotationIds: ["comment-ready"] } })).error).toBeUndefined()
    expect((await rpc("annotation.setStatus", { annotationId: "comment-ready", status: "resolved", client: "desktop" })).error).toBeUndefined()

    emit({ type: "turn-completed", params: { threadId: "thread-billing", turn: { id: "turn-1", status: "completed" } } })
    await waitForDaemon(async () => expect((await snapshot()).queuedSends?.find((queued) => queued.sessionId === sessionId)?.state).toBe("refused"))
    expect((await snapshot()).queuedSends?.find((queued) => queued.sessionId === sessionId)?.reason)
      .toBe("A comment sent with this message is not open on this session, so the message was not sent. Send it again without that comment.")
    expect(provider.startTurn).toHaveBeenCalledTimes(1)
  })

  it("answers a refused review with data naming why, as attachment and skill faults do", async () => {
    const { send } = await start()
    const comment = await send("Address", { review: { annotationIds: ["comment-missing"] } }) as { error?: { data?: unknown } }
    expect(comment.error?.data).toEqual({ kind: "session-review-refused", reason: "comment-unavailable" })
    const basis = await send("Build", { review: { annotationIds: [], buildBasis: { artifactId: "artifact-plan" } } }) as { error?: { data?: unknown } }
    expect(basis.error?.data).toEqual({ kind: "session-review-refused", reason: "build-basis-unavailable" })
  })
})
