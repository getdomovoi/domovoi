import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent, ProviderApprovalDecision } from "./agents.js"
import type { AuditLog } from "./audit-log.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import type { WorkspaceService } from "./workspace.js"

// A stored approval card outlives the provider process that raised it. The
// provider numbers its requests with a per-process counter, so after a daemon
// restart a new live request in another session can carry the same number as
// a card loaded from the store. Startup expires every stored card, so a
// decision on the stale card cannot reach the other session's live request,
// and the agent asks again if it still needs approval.

function checkpointingWorkspace(): WorkspaceService {
  return {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(), checkpoint: vi.fn(),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
  }
}

const roots: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(roots)
})

const staleSessionId = "session-billing"
const staleApprovalId = "approval-migrate"
const liveThreadId = "thread-live"

// Session A holds a card saved by the previous daemon process with provider
// request id 1 and no active turn. Session B is idle with a provider thread
// and no card.
function storedSnapshot(liveWorkspace: string): { snapshot: WorkspaceSnapshot, liveSessionId: string } {
  const snapshot = structuredClone(demoWorkspace)
  const stale = snapshot.sessions.find((candidate) => candidate.id === staleSessionId)!
  stale.runtime = { ...stale.runtime, provider: "codex", model: "gpt-5.6-sol", auto: false }
  stale.state = "waiting"
  stale.workspacePath = "/worktrees/session-billing"
  stale.providerThreadId = "thread-billing"
  delete stale.activeTurnId
  const live = snapshot.sessions.find((candidate) => candidate.id !== staleSessionId)!
  live.runtime = { ...live.runtime, provider: "codex", model: "gpt-5.6-sol", permissionMode: "build", auto: false }
  live.state = "active"
  live.workspacePath = liveWorkspace
  live.providerThreadId = liveThreadId
  delete live.activeTurnId
  snapshot.approvals = [{ ...demoWorkspace.approvals[0]!, id: staleApprovalId, sessionId: staleSessionId, risk: "normal", providerRequestId: 1 }]
  return { snapshot: workspaceSnapshotSchema.parse(snapshot), liveSessionId: live.id }
}

// A provider process that started after the restart. It numbers requests from
// a fresh counter and, like the real adapters, answers whichever live request
// holds the id it is given.
function freshProviderProcess() {
  let listener: ((event: AgentEvent) => void) | undefined
  let nextRequestId = 0
  const live = new Map<number, string>()
  const released: Array<{ requestId: number, owner: string, decision: ProviderApprovalDecision }> = []
  const adapter = {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "unused"),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn((requestId: number, decision: ProviderApprovalDecision) => {
      const owner = live.get(requestId)
      if (owner === undefined) return
      live.delete(requestId)
      released.push({ requestId, owner, decision })
    }),
    onEvent: (next: (event: AgentEvent) => void) => {
      listener = next
      return () => { listener = undefined }
    },
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const request = (owner: string, event: Omit<Extract<AgentEvent, { type: "approval-requested" }>, "type" | "requestId">) => {
    const requestId = ++nextRequestId
    live.set(requestId, owner)
    listener!({ type: "approval-requested", requestId, ...event })
    return requestId
  }
  return { adapter, request, released, live }
}

function recordingAuditLog() {
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-stale-${append.mock.calls.length}`,
    occurredAt: "2026-09-24T12:00:00.000Z",
    ...input,
  }))
  const auditLog = {
    append,
    query: vi.fn(() => ({ entries: [], hasMore: false })),
    export: vi.fn(() => ({
      format: "jsonl" as const,
      exportedAt: "2026-09-24T12:00:00.000Z",
      content: "",
      entryCount: 0,
      hasMore: false,
    })),
  } satisfies AuditLog
  return { append, auditLog }
}

async function connect(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
      const id = ++nextId
      responses.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  const hello = await rpc("system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })
  expect(hello.error).toBeUndefined()
  return rpc
}

async function restartedDaemon() {
  const profileDirectory = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-profile-"))
  const liveWorkspace = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-live-"))
  roots.push(profileDirectory, liveWorkspace)
  const { snapshot, liveSessionId } = storedSnapshot(liveWorkspace)
  // Each save records whether a client could have been connected when it ran.
  const saves: Array<{ listening: boolean, snapshot: WorkspaceSnapshot }> = []
  // The store closure below reads the daemon that is constructed after it.
  // eslint-disable-next-line prefer-const
  let daemon: DomovoiDaemon
  const record = (next: WorkspaceSnapshot) => {
    saves.push({ listening: daemon.address !== undefined, snapshot: structuredClone(next) })
  }
  const store = {
    load: () => structuredClone(snapshot),
    save: vi.fn(record),
    saveAsync: vi.fn(async (next: WorkspaceSnapshot) => record(next)),
    close: vi.fn(),
  } satisfies WorkspaceStore
  const { append, auditLog } = recordingAuditLog()
  const provider = freshProviderProcess()
  daemon = new DomovoiDaemon({
    port: 0,
    profileDirectory,
    store,
    auditLog,
    agents: { codex: provider.adapter },
    workspaceService: checkpointingWorkspace(),
    errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const rpc = await connect(daemon, port)
  const workspace = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  return { rpc, workspace, provider, liveSessionId, liveWorkspace, snapshot, saves, append }
}

async function restartedDaemonWithLiveRequest() {
  const restarted = await restartedDaemon()
  const { workspace, provider, liveSessionId, liveWorkspace } = restarted
  const liveRequestId = provider.request(liveSessionId, {
    threadId: liveThreadId,
    itemId: "item-live",
    command: "touch generated.txt",
    reason: "Write a generated file",
    cwd: liveWorkspace,
  })
  expect(liveRequestId).toBe(1)
  const liveCard = await vi.waitFor(async () => {
    const card = (await workspace()).approvals.find((approval) => approval.sessionId === liveSessionId)
    expect(card).toBeDefined()
    return card!
  }, { timeout: 5_000 })
  expect(liveCard.providerRequestId).toBe(1)
  expect(provider.released).toEqual([])
  return { ...restarted, liveCard }
}

describe("stored approval cards after a restart", () => {
  it("expires a stored card on a session without an active turn before any client connects", async () => {
    const { workspace, provider, snapshot, saves, append } = await restartedDaemon()

    const expiry = saves.find((save) => !save.snapshot.approvals.some((approval) => approval.id === staleApprovalId))
    expect(expiry).toBeDefined()
    expect(expiry!.listening).toBe(false)

    const loaded = await workspace()
    expect(loaded.approvals).toEqual([])
    const stale = loaded.sessions.find((session) => session.id === staleSessionId)!
    expect(stale.state).toBe("idle")
    expect(stale).not.toHaveProperty("activeTurnId")
    expect(stale.providerThreadId).toBe("thread-billing")
    expect(loaded.thread.filter((item) => item.sessionId === staleSessionId))
      .toEqual(snapshot.thread.filter((item) => item.sessionId === staleSessionId))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: "daemon", component: "startup-recovery" },
      action: "approval.expired",
      outcome: "cancelled",
      sessionId: staleSessionId,
      target: staleApprovalId,
    }))
    expect(append).not.toHaveBeenCalledWith(expect.objectContaining({ action: "session.turn-interrupted" }))
    expect(provider.adapter.resolveApproval).not.toHaveBeenCalled()
  })

  it("gives a new request after the restart a card that can be allowed", async () => {
    const { rpc, workspace, provider, liveSessionId, liveCard } = await restartedDaemonWithLiveRequest()

    const allowed = await rpc("approval.resolve", {
      approvalId: liveCard.id, decision: "allow-once", client: "desktop",
    })
    expect(allowed.error).toBeUndefined()

    expect(provider.released).toEqual([{ requestId: 1, owner: liveSessionId, decision: "allow-once" }])
    expect((await workspace()).approvals).toEqual([])
  })

  it("does not release another session's live request when the stale card is allowed", async () => {
    const { rpc, workspace, provider, liveSessionId, liveCard } = await restartedDaemonWithLiveRequest()

    const allowed = await rpc("approval.resolve", {
      approvalId: staleApprovalId, decision: "allow-once", client: "desktop",
    })

    expect(provider.released.filter((release) => release.owner === liveSessionId)).toEqual([])
    expect(provider.live.has(1)).toBe(true)
    const after = await workspace()
    expect(after.approvals.map(({ id }) => id)).toEqual([liveCard.id])
    expect(allowed.error).toMatchObject({ message: "Approval does not exist" })
  })

  it("does not deny another session's live request when the stale card's session is archived", async () => {
    const { rpc, workspace, provider, liveSessionId, liveCard } = await restartedDaemonWithLiveRequest()

    await rpc("session.archive", { sessionId: staleSessionId, client: "desktop" })

    expect(provider.released.filter((release) => release.owner === liveSessionId)).toEqual([])
    expect(provider.live.has(1)).toBe(true)
    const after = await workspace()
    expect(after.approvals.map(({ id }) => id)).toEqual([liveCard.id])
  })
})
