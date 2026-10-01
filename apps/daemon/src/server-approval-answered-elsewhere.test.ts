import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { AuditLog } from "./audit-log.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

// Q243 A, 2026-10-01: an OpenCode or Kilo server's password is readable by
// any program the server starts. When the adapter sees an approval reply it
// did not send, it stops the thread and says so; the daemon then fails the
// session with its own failure, drops the session's cards, holds a queued
// send, records the stop in the audit log, and resumes the thread afresh
// only when the person sends again.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const sessionId = "session-billing"
const threadId = "ses_billing"
const answeredElsewhere = {
  kind: "approval-answered-elsewhere",
  action: "review-changes",
  message: "An approval was answered outside Domovoi",
  retryable: false,
} as const
const notice = "An approval in this session was answered outside Domovoi, so Domovoi stopped the session."

function openCodeSession(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "opencode", model: "anthropic/sonnet", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = threadId
  delete session.activeTurnId
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

function recordingAuditLog() {
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-elsewhere-${append.mock.calls.length}`,
    occurredAt: "2026-10-01T12:00:00.000Z",
    ...input,
  }))
  const auditLog = {
    append,
    query: vi.fn(() => ({ entries: [], hasMore: false })),
    export: vi.fn(() => ({
      format: "jsonl" as const,
      exportedAt: "2026-10-01T12:00:00.000Z",
      content: "",
      entryCount: 0,
      hasMore: false,
    })),
  } satisfies AuditLog
  return { append, auditLog }
}

async function start() {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn<() => Promise<string>>().mockResolvedValueOnce("turn-billing").mockResolvedValue("turn-billing-2"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
  } satisfies WorkspaceService
  const { append, auditLog } = recordingAuditLog()
  const daemon = new DomovoiDaemon({
    port: 0, store: new SqliteWorkspaceStore(":memory:", openCodeSession()), auditLog,
    agents: { opencode: provider }, workspaceService, errorSink: vi.fn(),
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
  emit({ type: "approval-requested", requestId: 41, threadId, turnId: "turn-billing", itemId: "call_build", command: "pnpm build" })
  await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
  return { provider, rpc, snapshot, session, append, emit: (event: AgentEvent) => emit(event) }
}

describe("an approval answered outside Domovoi", () => {
  it("fails the session with its own failure, drops its cards, says why and records it", async () => {
    const { provider, rpc, snapshot, session, append, emit } = await start()
    expect(provider.resumeThread).toHaveBeenCalledOnce()

    emit({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-billing",
        turn: { id: "turn-billing", status: "failed", error: answeredElsewhere.message },
        failure: answeredElsewhere,
      },
    })
    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_1", reply: "once" })

    await waitForDaemon(async () => expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
    })))
    expect(append).toHaveBeenCalledWith({
      actor: { kind: "provider", provider: "opencode", providerThreadId: threadId },
      action: "provider.approval-answered-elsewhere",
      outcome: "denied",
      sessionId,
      projectId: (await session()).projectId,
      target: "per_1",
      detail: "reply=once",
    })
    const stopped = await session()
    expect(stopped.state).toBe("failed")
    expect(stopped.providerFailure).toEqual(answeredElsewhere)
    expect(stopped).not.toHaveProperty("activeTurnId")
    expect(stopped.providerThreadId).toBe(threadId)
    const after = await snapshot()
    expect(after.approvals).toEqual([])
    expect(after.thread).toContainEqual(expect.objectContaining({ sessionId, kind: "system", body: notice }))

    // The adapter unloaded the thread, so the next send resumes it first.
    const again = await rpc("session.send", { sessionId, prompt: "go on", client: "desktop" })
    expect(again.error?.message).toBeUndefined()
    expect(provider.resumeThread).toHaveBeenCalledTimes(2)
  })

  it("fails the session when the stop arrives with no turn running", async () => {
    const { session, append, emit } = await start()
    emit({ type: "turn-completed", params: { threadId, turnId: "turn-billing", turn: { id: "turn-billing", status: "completed" } } })
    await waitForDaemon(async () => expect((await session()).state).toBe("idle"))

    emit({ type: "approval-answered-elsewhere", threadId, permissionId: "per_late", reply: "always" })

    await waitForDaemon(async () => expect((await session()).state).toBe("failed"))
    expect((await session()).providerFailure).toEqual(answeredElsewhere)
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
      target: "per_late",
      detail: "reply=always",
    }))
  })
})
