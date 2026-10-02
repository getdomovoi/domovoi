import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AuditLog } from "./audit-log.js"
import { OpenCodeSdkAdapter, openCodeBuiltInToolIds, type OpenCodeClient, type OpenCodeEvent } from "./opencode.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"
import { UsageLedger } from "./usage.js"
import type { WorkspaceService } from "./workspace.js"

// Security review round 14 of #687 (ruling Q308): when overlapping
// thread-wide stops defer a turn's end to the last of them, the daemon must
// still hear that end before the incident and the disconnect, which drop the
// session's thread and turn. Otherwise the turn's end finds no turn: the
// session is not stored as failed by it, no provider.turn-completed entry is
// written, and usage ends "interrupted" instead of "failed". The OpenCode
// adapter here is the real one; its server, client and event stream are
// mocks, and no daemon process or provider runs.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratch)
})

const sessionId = "session-billing"
const threadId = "ses_billing"
const turnId = "msg_turn"
const answeredElsewhere = {
  kind: "approval-answered-elsewhere",
  action: "review-changes",
  message: "An approval was answered outside Domovoi",
  retryable: false,
} as const

class EventStream implements AsyncIterable<OpenCodeEvent> {
  #events: OpenCodeEvent[] = []
  #waiters: Array<(result: IteratorResult<OpenCodeEvent>) => void> = []
  #closed = false

  emit(event: OpenCodeEvent): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.#events.push(event)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<OpenCodeEvent> {
    return {
      next: async () => {
        const event = this.#events.shift()
        if (event) return { value: event, done: false }
        if (this.#closed) return { value: undefined, done: true }
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

function openCodeSession(workspacePath: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "opencode", model: "anthropic/sonnet", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = workspacePath
  session.providerThreadId = threadId
  delete session.activeTurnId
  snapshot.approvals = []
  snapshot.approvalRules = []
  return workspaceSnapshotSchema.parse(snapshot)
}

async function start() {
  const workspacePath = await mkdtemp(join(tmpdir(), "domovoi-stop-order-"))
  scratch.push(workspacePath)
  const stream = new EventStream()
  // Aborts wait for a manual answer, by provider session.
  const waiting = new Map<string, Array<(ok: boolean) => void>>()
  let replyPost: { refuse: () => void } | undefined
  const client = {
    config: {
      get: vi.fn(async () => ({ data: { model: "anthropic/sonnet" } })),
      providers: vi.fn(async () => ({
        data: {
          default: { anthropic: "sonnet" },
          providers: [{
            id: "anthropic",
            name: "Anthropic",
            models: { sonnet: { id: "sonnet", providerID: "anthropic", name: "Sonnet", capabilities: { reasoning: true }, status: "active" } },
          }],
        },
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: threadId } })),
      get: vi.fn(async () => ({ data: { id: threadId } })),
      delete: vi.fn(async () => ({ data: true })),
      abort: vi.fn((...args: unknown[]) => {
        const id = (args[0] as { path: { id: string } }).path.id
        return new Promise<{ data: boolean }>((resolve, reject) => {
          const answers = waiting.get(id) ?? []
          answers.push((ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused"))))
          waiting.set(id, answers)
        })
      }),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async (_options?: unknown): Promise<{ data: unknown; response?: Response }> => ({ data: [] })),
      status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })),
    },
    event: { subscribe: vi.fn(async () => ({ stream })) },
    postSessionIdPermissionsPermissionId: vi.fn(() => new Promise<{ data: boolean }>((_resolve, reject) => {
      replyPost = { refuse: () => reject(new Error("refused")) }
    })),
    mcp: { status: vi.fn(async () => ({ data: {} })) },
    tool: { ids: vi.fn(async () => ({ data: [...openCodeBuiltInToolIds] })) },
    app: {
      agents: vi.fn(async () => ({
        data: ["build", "plan", "domovoi-auto", "domovoi-ask"].map((name) => ({ name, mode: "primary", permission: [{ permission: "*", pattern: "*", action: "ask" }] })),
      })),
    },
  } satisfies OpenCodeClient
  const server = { close: vi.fn(), stop: vi.fn(async () => true) }
  const adapter = new OpenCodeSdkAdapter(async () => ({ client, server }), () => turnId)
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-${append.mock.calls.length}`,
    occurredAt: "2026-10-01T12:00:00.000Z",
    ...input,
  }))
  const auditLog = {
    append,
    query: vi.fn(() => ({ entries: [], hasMore: false })),
    export: vi.fn(() => ({ format: "jsonl" as const, exportedAt: "2026-10-01T12:00:00.000Z", content: "", entryCount: 0, hasMore: false })),
  } satisfies AuditLog
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(async () => ({ commit: "a".repeat(40), changedFiles: [] })),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
    archiveSessionWorkspace: vi.fn(async () => {}),
  } satisfies WorkspaceService
  const usageLedger = new UsageLedger()
  const store = new SqliteWorkspaceStore(":memory:", openCodeSession(workspacePath))
  const daemon = new DomovoiDaemon({
    port: 0, store, auditLog, usageLedger,
    agents: { opencode: adapter }, workspaceService, errorSink: vi.fn(),
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
  const session = async () => (await snapshot()).sessions.find(({ id }) => id === sessionId)!
  const sent = await rpc("session.send", { sessionId, prompt: "build it", client: "desktop" })
  expect(sent.error?.message).toBeUndefined()
  await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
  const answer = async (id: string) => {
    await waitForDaemon(() => expect(waiting.get(id)?.length ?? 0).toBeGreaterThan(0))
    waiting.get(id)!.shift()!(true)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
  return {
    client, stream, rpc, snapshot, session, append, usageLedger, answer, settle,
    pendingAborts: (id: string) => waiting.get(id)?.length ?? 0,
    refuseReply: () => replyPost!.refuse(),
  }
}

type Started = Awaited<ReturnType<typeof start>>

async function expectFailedTurn({ session, append, usageLedger }: Started) {
  // The incident reached the daemon in every case.
  await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.approval-answered-elsewhere" })))
  await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed" })))
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed", outcome: "failed", sessionId }))
  const stopped = await session()
  expect(stopped.state).toBe("failed")
  expect(stopped.providerFailure).toEqual(answeredElsewhere)
  expect(usageLedger.lookup({ provider: "opencode", threadId, turnId })?.accounting?.status).toBe("failed")
}

describe("a turn ended by overlapping thread stops, through the daemon", () => {
  it("is stored failed when a closed stream's stop settles before a later approval stop", async () => {
    const started = await start()
    const { stream, client, rpc, snapshot, answer, settle, pendingAborts, refuseReply } = started
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: threadId, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [], tool: { messageID: "msg_1", callID: "call_1" } },
    })
    await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
    const card = (await snapshot()).approvals[0]!
    expect((await rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "desktop" })).error).toBeUndefined()
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    // The server reports the reply before it answers the request.
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
    await settle()
    stream.close()
    await answer(threadId)
    await settle()
    // The answer fails, so the reply was someone else's: a second stop.
    refuseReply()
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    await answer("ses_child")
    await settle()
    await answer(threadId)
    await expectFailedTurn(started)
  })

  it("is stored failed when an approval stop settles while a closed stream's stop and the server stop are pending", async () => {
    const started = await start()
    const { stream, answer, settle } = started
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
    await settle()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    await settle()
    stream.close()
    await settle()
    await answer(threadId)
    await settle()
    await answer("ses_child")
    await expectFailedTurn(started)
  })
})
