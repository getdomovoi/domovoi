import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

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
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import type { WorkspaceService } from "./workspace.js"

// A stored approval card outlives the provider process that raised it. The
// provider numbers its requests with a per-process counter, so after a daemon
// restart a new live request in another session can carry the same number as
// a card loaded from the store. Startup, and reopening a project's saved
// state, expire every stored card, so a decision on the stale card cannot
// reach the other session's live request. The agent asks again when the
// session continues.

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
  const notifications: Array<{ method: string, params: unknown }> = []
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number, method?: string, params?: unknown }
    if (message.id !== undefined) responses.get(message.id)?.(message)
    else if (message.method !== undefined) notifications.push({ method: message.method, params: message.params })
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
  return Object.assign(rpc, { notifications })
}

const expiredNotice = "Domovoi restarted, so this approval request expired. Send a message to continue."
const noticesIn = (snapshot: WorkspaceSnapshot) =>
  snapshot.thread.filter((item) => item.kind === "system" && item.body === expiredNotice)

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
    expect(loaded.thread.filter((item) => item.sessionId === staleSessionId)).toEqual([
      ...snapshot.thread.filter((item) => item.sessionId === staleSessionId),
      expect.objectContaining({ sessionId: staleSessionId, kind: "system", body: expiredNotice }),
    ])
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

  it("does not send a decision for a stored card while startup resumes an archive", async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-profile-"))
    const liveWorkspace = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-live-"))
    roots.push(profileDirectory, liveWorkspace)
    const { snapshot } = storedSnapshot(liveWorkspace)
    const archiving = snapshot.sessions.find((session) => session.id === staleSessionId)!
    archiving.state = "archiving"
    archiving.archiveRequestedAt = "2026-09-24T11:00:00.000Z"
    const provider = freshProviderProcess()
    const daemon = new DomovoiDaemon({
      port: 0,
      profileDirectory,
      store: { load: () => structuredClone(workspaceSnapshotSchema.parse(snapshot)), save: vi.fn(), close: vi.fn() },
      agents: { codex: provider.adapter },
      workspaceService: checkpointingWorkspace(),
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const { port } = await daemon.start()

    expect(provider.adapter.resolveApproval).not.toHaveBeenCalled()
    const rpc = await connect(daemon, port)
    const after = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(after.approvals).toEqual([])
  })
})

describe("the thread notice for an expired card", () => {
  it("tells each session whose stored card expired once, and keeps the line across saves and restarts", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-notice-"))
    const liveWorkspace = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-live-"))
    roots.push(scratch, liveWorkspace)
    const statePath = join(scratch, "state.sqlite")
    const { snapshot } = storedSnapshot(liveWorkspace)
    const card = snapshot.approvals[0]!
    snapshot.approvals = [card, { ...card, id: "approval-second", providerRequestId: 2 }]
    const initial = workspaceSnapshotSchema.parse(snapshot)
    const start = async () => {
      const daemon = new DomovoiDaemon({
        port: 0,
        profileDirectory: scratch,
        store: new SqliteWorkspaceStore(statePath, initial),
        agents: { codex: freshProviderProcess().adapter },
        workspaceService: checkpointingWorkspace(),
        errorSink: vi.fn(),
      })
      daemons.push(daemon)
      const rpc = await connect(daemon, (await daemon.start()).port)
      const workspace = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
      return { daemon, rpc, workspace }
    }

    const first = await start()
    const notices = noticesIn(await first.workspace())
    expect(notices).toEqual([expect.objectContaining({ sessionId: staleSessionId, kind: "system", body: expiredNotice })])
    expect(notices[0]).not.toHaveProperty("detail")

    expect((await first.rpc("session.activate", { sessionId: staleSessionId, client: "desktop" })).error).toBeUndefined()
    const changed = await vi.waitFor(() => {
      const notification = first.rpc.notifications.find(({ method }) => method === "workspace.changed")
      expect(notification).toBeDefined()
      return notification!
    }, { timeout: 5_000 })
    expect(noticesIn(workspaceSnapshotSchema.parse(changed.params))).toEqual(notices)
    await first.daemon.stop()

    const second = await start()
    expect(noticesIn(await second.workspace())).toEqual(notices)
  })
})

function projectIdFor(root: string): string {
  return `project-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
}

// Every path opens as its own repository, named after its last segment.
function projectWorkspaces(): WorkspaceService {
  return {
    ...checkpointingWorkspace(),
    inspect: vi.fn(async (path: string) => ({ root: path, name: basename(path), branch: "main", head: "a".repeat(40) })),
  }
}

describe("stored approval cards in another project's saved state", () => {
  it("expires a card saved with a project when that project opens after a restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-project-"))
    const liveWorkspace = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-live-"))
    roots.push(scratch, liveWorkspace)
    const statePath = join(scratch, "state.sqlite")
    const rootA = "/code/project-a"
    const rootB = "/code/project-b"
    const { snapshot: base, liveSessionId } = storedSnapshot(liveWorkspace)
    const projectA = { ...base.project!, id: projectIdFor(rootA), name: "project-a", path: rootA, branch: "main" }
    const initial = workspaceSnapshotSchema.parse({
      ...base,
      project: projectA,
      sessions: base.sessions.map((session) => ({
        ...session,
        projectId: projectA.id,
        ...(session.id === staleSessionId ? { state: "idle" } : {}),
      })),
      approvals: [],
    })

    // First process: project A's provider raises request 1 on a session with
    // no active turn, then the person switches to project B, which saves A
    // with its card.
    const firstProvider = freshProviderProcess()
    const first = new DomovoiDaemon({
      port: 0,
      profileDirectory: scratch,
      store: new SqliteWorkspaceStore(statePath, initial),
      agents: { codex: firstProvider.adapter },
      workspaceService: projectWorkspaces(),
      errorSink: vi.fn(),
    })
    daemons.push(first)
    const firstRpc = await connect(first, (await first.start()).port)
    const firstWorkspace = async () => workspaceSnapshotSchema.parse((await firstRpc("workspace.get", {})).result)
    expect(firstProvider.request(staleSessionId, {
      threadId: "thread-billing",
      itemId: "item-stale",
      command: "touch stale.txt",
      reason: "Write a stale file",
    })).toBe(1)
    await vi.waitFor(async () => {
      expect((await firstWorkspace()).approvals.map(({ providerRequestId }) => providerRequestId)).toEqual([1])
    }, { timeout: 5_000 })
    const staleCardId = (await firstWorkspace()).approvals[0]!.id
    const refused = await firstRpc("project.open", { path: rootB, client: "desktop" })
    const confirmation = (refused.error as unknown as { data: unknown }).data
    expect((await firstRpc("project.open", { path: rootB, client: "desktop", confirmation })).error).toBeUndefined()
    await first.stop()

    // Second process: it starts in project B, then the person opens A again.
    const { append, auditLog } = recordingAuditLog()
    const secondProvider = freshProviderProcess()
    const second = new DomovoiDaemon({
      port: 0,
      profileDirectory: scratch,
      store: new SqliteWorkspaceStore(statePath, initial),
      auditLog,
      agents: { codex: secondProvider.adapter },
      workspaceService: projectWorkspaces(),
      errorSink: vi.fn(),
    })
    daemons.push(second)
    const rpc = await connect(second, (await second.start()).port)
    const workspace = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect((await workspace()).project?.path).toBe(rootB)
    const reopened = await rpc("project.open", { path: rootA, client: "desktop" })
    expect(reopened.error).toBeUndefined()
    expect((await workspace()).project?.id).toBe(projectA.id)

    // A live request in this process carries the stale card's id.
    expect(secondProvider.request(liveSessionId, {
      threadId: liveThreadId,
      itemId: "item-live",
      command: "touch generated.txt",
      reason: "Write a generated file",
      cwd: liveWorkspace,
    })).toBe(1)
    const liveCard = await vi.waitFor(async () => {
      const card = (await workspace()).approvals.find((approval) => approval.sessionId === liveSessionId)
      expect(card).toBeDefined()
      return card!
    }, { timeout: 5_000 })
    const allowed = await rpc("approval.resolve", { approvalId: staleCardId, decision: "allow-once", client: "desktop" })
    await rpc("session.archive", { sessionId: staleSessionId, client: "desktop" })

    expect(secondProvider.released).toEqual([])
    expect(secondProvider.live.has(1)).toBe(true)
    expect(allowed.error).toMatchObject({ message: "Approval does not exist" })
    const after = await workspace()
    expect(after.approvals.map(({ id }) => id)).toEqual([liveCard.id])
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: "daemon", component: "project-open" },
      action: "approval.expired",
      outcome: "cancelled",
      sessionId: staleSessionId,
      projectId: projectA.id,
      target: staleCardId,
    }))
  })

  it("moves a session that was only waiting on a card saved with its project to idle", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-project-"))
    const liveWorkspace = await mkdtemp(join(tmpdir(), "domovoi-stale-approval-live-"))
    roots.push(scratch, liveWorkspace)
    const statePath = join(scratch, "state.sqlite")
    const rootA = "/code/project-a"
    const rootB = "/code/project-b"
    const { snapshot: base } = storedSnapshot(liveWorkspace)
    const projectA = { ...base.project!, id: projectIdFor(rootA), name: "project-a", path: rootA, branch: "main" }
    const initial = workspaceSnapshotSchema.parse({
      ...base,
      project: projectA,
      sessions: base.sessions.map((session) => ({
        ...session,
        projectId: projectA.id,
        ...(session.id === staleSessionId ? { state: "idle" } : {}),
      })),
      approvals: [],
    })
    const provider = freshProviderProcess()
    const daemon = new DomovoiDaemon({
      port: 0,
      profileDirectory: scratch,
      store: new SqliteWorkspaceStore(statePath, initial),
      agents: { codex: provider.adapter },
      workspaceService: projectWorkspaces(),
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const rpc = await connect(daemon, (await daemon.start()).port)
    const workspace = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    provider.request(staleSessionId, { threadId: "thread-billing", itemId: "item-stale", command: "touch stale.txt", reason: "Write a stale file" })
    await vi.waitFor(async () => expect((await workspace()).approvals).toHaveLength(1), { timeout: 5_000 })
    expect((await workspace()).sessions.find((session) => session.id === staleSessionId)?.state).toBe("waiting")
    const refused = await rpc("project.open", { path: rootB, client: "desktop" })
    const confirmation = (refused.error as unknown as { data: unknown }).data
    expect((await rpc("project.open", { path: rootB, client: "desktop", confirmation })).error).toBeUndefined()

    expect((await rpc("project.open", { path: rootA, client: "desktop" })).error).toBeUndefined()
    const opened = await workspace()
    expect(opened.approvals).toEqual([])
    expect(opened.sessions.find((session) => session.id === staleSessionId)?.state).toBe("idle")
    // No restart happened here, so the restart notice does not apply.
    expect(noticesIn(opened)).toEqual([])
  })
})
