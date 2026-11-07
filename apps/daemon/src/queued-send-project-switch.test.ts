import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { createEmptyWorkspace, demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

type RpcReply = { result?: Record<string, unknown> & { queuedSends?: Array<{ id: string; sessionId: string; state: string }> }; error?: { code: number; message: string; data?: unknown } }

afterEach(() => vi.restoreAllMocks())

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(projectCap?: number, saved?: WorkspaceSnapshot, missingPaths: string[] = []) {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-switch-"))
  const listeners = new Set<(event: AgentEvent) => void>()
  let turn = 0
  let thread = 0
  const agent = {
    connect: async () => {},
    listModels: async () => [{
      provider: "codex", id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Coding model",
      supportedReasoningEfforts: ["none", "medium", "high"], defaultReasoningEffort: "medium", isDefault: true,
    }],
    startThread: vi.fn(async () => `provider-thread-${++thread}`),
    resumeThread: async () => {},
    stopThread: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    startTurn: async () => `provider-turn-${++turn}`,
    steerTurn: async () => {},
    resolveApproval: () => {},
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: async () => {},
  } as unknown as AgentAdapter
  const workspaceService = {
    inspect: async (path: string) => {
      if (missingPaths.includes(path)) throw Object.assign(new Error("Folder missing"), { code: "ENOENT" })
      return { root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }
    },
    createSessionWorkspace: async (_path: string, sessionId: string) => ({
      path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40),
    }),
    removeSessionWorkspace: async () => {},
    checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
    restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
  } as unknown as WorkspaceService
  const terminal = { process: "test-shell", write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })), onExit: vi.fn(() => ({ dispose: vi.fn() })),
  }
  const errors: unknown[] = []
  const initial = createEmptyWorkspace({
    id: `machine-${"9".repeat(32)}`, name: "queued-switch", platform: process.platform, arch: process.arch,
    version: "0.0.1", connection: "local", reachable: true, providers: [],
  })
  let store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), initial)
  if (saved) {
    store.save(saved)
    await store.close()
    store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), initial)
  }
  const daemon = new DomovoiDaemon({
    port: 0,
    ...(projectCap !== undefined ? { projectCap } : {}),
    store,
    agents: { codex: agent },
    workspaceService,
    terminalService: { spawn: () => terminal },
    agentTimeoutMs: 500,
    modelCacheTtlMs: 0,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    errorSink: (error: unknown) => { errors.push(error) },
  })
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  cleanups.push(async () => {
    socket.terminate()
    await daemon.stop()
    await rm(scratch, { recursive: true, force: true })
  })
  await once(socket, "open")
  let id = 0
  const rpc = (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<RpcReply>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data)) as RpcReply & { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  expect(await rpc("system.hello", {
    client: "desktop", clientId: "desktop-queued-switch", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).not.toHaveProperty("error")
  const completeTurn = (turnId: string) => {
    for (const listener of listeners) {
      listener({ type: "turn-completed", params: { threadId: "provider-thread-1", turnId, status: "completed" } } as AgentEvent)
    }
  }
  const openProject = async (path: string) => {
    return rpc("project.open", { path, client: "desktop" })
  }
  return { rpc, completeTurn, openProject, errors, agent, store, workspaceService, terminal, emit: (event: AgentEvent) => { for (const listener of listeners) listener(event) } }
}

const runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build", auto: false }

describe("queued sends across a project switch", () => {
  it("switches projects after a queued send was delivered", async () => {
    const { rpc, completeTurn, openProject, errors } = await fixture()
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    expect(await rpc("session.send", {
      sessionId, prompt: "queued", client: "desktop", delivery: "next-turn-replace",
    })).not.toHaveProperty("error")
    completeTurn("provider-turn-1")
    await expect.poll(async () => (await rpc("workspace.get", {})).result?.queuedSends?.map((queued) => queued.state))
      .toEqual(["delivered"])

    const switched = await openProject("/code/two")
    expect(switched.error).toBeUndefined()
    expect(switched.result).toMatchObject({ project: { path: "/code/two" }, queuedSends: [expect.objectContaining({ sessionId, state: "delivered" })] })
    expect((await rpc("workspace.get", {})).error).toBeUndefined()
    expect(errors).toEqual([])
  })

  it("delivers A's waiting send while B is focused without stopping A", async () => {
    const { rpc, openProject, errors, completeTurn, agent } = await fixture()
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    const queued = await rpc("session.send", {
      sessionId, prompt: "queued", client: "desktop", delivery: "next-turn-replace",
    })
    const queueId = queued.result?.queuedSends?.[0]?.id

    const away = await openProject("/code/two")
    expect(away.error).toBeUndefined()
    expect(away.result?.queuedSends).toEqual([expect.objectContaining({ id: queueId, sessionId, state: "waiting" })])
    expect(agent.stopThread).not.toHaveBeenCalled()
    expect(agent.interruptTurn).not.toHaveBeenCalled()
    completeTurn("provider-turn-1")
    await expect.poll(async () => (await rpc("workspace.get", {})).result?.queuedSends?.[0]?.state).toBe("delivered")

    const back = await openProject("/code/one")
    expect(back.error).toBeUndefined()
    expect(back.result?.queuedSends).toEqual([expect.objectContaining({ id: queueId, sessionId, state: "delivered" })])
    expect(errors).toEqual([])
  })
})

it("admits three projects, refuses a fourth, and refocuses existing state", async () => {
  const { rpc, openProject } = await fixture()
  const first = await openProject("/code/one")
  const project = first.result?.project as { id: string }
  const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
  const sessionId = created.result?.activeSessionId as string
  expect((await openProject("/code/two")).error).toBeUndefined()
  const third = await openProject("/code/three")
  expect(third.result?.projects).toHaveLength(3)
  const refused = await openProject("/code/four")
  expect(refused.error?.data).toMatchObject({ kind: "project_cap", cap: 3 })
  expect((await rpc("workspace.get", {})).result?.projects).toHaveLength(3)
  const activated = await rpc("session.activate", { sessionId, client: "desktop" })
  expect(activated.result).toMatchObject({ project: { id: project.id }, activeSessionId: sessionId })
  expect((await openProject("/code/one")).error).toBeUndefined()
})

it("enforces a configured cap without stopping work", async () => {
  const { openProject } = await fixture(1)
  expect((await openProject("/code/one")).error).toBeUndefined()
  expect((await openProject("/code/two")).error?.data).toMatchObject({ kind: "project_cap", cap: 1 })
  expect((await openProject("/code/one")).error).toBeUndefined()
})

it("restores every active project above a reduced cap and retains missing folders", async () => {
  const original = await fixture()
  for (const path of ["/code/one", "/code/two", "/code/three"]) {
    expect((await original.openProject(path)).error).toBeUndefined()
    const created = await original.rpc("session.create", { title: path, runtime, client: "desktop" })
    expect(created.error).toBeUndefined()
    expect((await original.rpc("session.send", { sessionId: created.result!.activeSessionId, prompt: "work", client: "desktop" })).error).toBeUndefined()
  }
  const saved = (await original.rpc("workspace.get", {})).result as unknown as WorkspaceSnapshot
  for (const session of saved.sessions) delete session.activeTurnStartedAt
  delete saved.turns
  saved.approvals = saved.sessions.map((session, index) => ({ ...structuredClone(demoWorkspace.approvals[0]!), id: `approval-${index}`, sessionId: session.id }))
  const restarted = await fixture(2, saved, ["/code/one"])
  const restored = (await restarted.rpc("workspace.get", {})).result as unknown as WorkspaceSnapshot
  expect(restored.projects).toHaveLength(3)
  expect(restored.projectCap).toBe(2)
  expect(restored.sessions).toHaveLength(3)
  expect(restored.sessions.every((session) => !session.activeTurnId)).toBe(true)
  expect(restored.approvals).toEqual([])
  const expired = restarted.store.auditLog.query({}).entries.filter((entry) => entry.action === "approval.expired")
  expect(expired).toHaveLength(3)
  for (const entry of expired) expect(entry.projectId).toBe(restored.sessions.find((session) => session.id === entry.sessionId)!.projectId)
  expect(restored.projects!.find((project) => project.path === "/code/one")).toHaveProperty("unavailableReason", "folder-missing")
  expect((await restarted.openProject("/code/four")).error?.data).toMatchObject({ kind: "project_cap", cap: 2 })
  expect((await restarted.openProject("/code/two")).error).toBeUndefined()
  const missing = restored.sessions.find((session) => session.projectId === restored.projects!.find((project) => project.path === "/code/one")!.id)!
  const refused = await restarted.rpc("session.send", { sessionId: missing.id, prompt: "work", client: "desktop" })
  expect(refused.error?.message).toMatch(/folder.*unavailable/i)
  expect(restarted.agent.startThread).not.toHaveBeenCalled()
})

it("does not attribute provider-wide or stale-session audit events to focus", async () => {
  const { rpc, openProject, emit, store } = await fixture()
  await openProject("/code/one")
  await rpc("session.create", { title: "one", runtime, client: "desktop" })
  await openProject("/code/two")
  await rpc("session.create", { title: "two", runtime, client: "desktop" })
  emit({ type: "provider-disconnected", reason: "test disconnect" })
  await expect.poll(() => store.auditLog.query({}).entries.filter((entry) => entry.action === "provider.disconnected").length).toBe(1)
  expect(store.auditLog.query({}).entries.find((entry) => entry.action === "provider.disconnected")).not.toHaveProperty("projectId")
  await rpc("session.send", { sessionId: "gone", prompt: "work", client: "desktop" })
  const stale = store.auditLog.query({}).entries.filter((entry) => entry.sessionId === "gone")
  expect(stale.length).toBeGreaterThan(0)
  expect(stale.every((entry) => entry.projectId === undefined)).toBe(true)
})

it("keeps A's stream while opening B recovers a pending creation", async () => {
  const { rpc, openProject, emit, store, workspaceService } = await fixture()
  await openProject("/code/one")
  const created = await rpc("session.create", { title: "A", runtime, client: "desktop" })
  const sessionId = created.result!.activeSessionId as string
  await rpc("session.send", { sessionId, prompt: "work", client: "desktop" })
  emit({ type: "text-delta", threadId: "provider-thread-1", turnId: "provider-turn-1", delta: "A kept " })
  await rpc("workspace.get", {})
  const projectId = `project-${createHash("sha256").update("/code/two").digest("hex").slice(0, 12)}`
  const recovered = { ...store.load().sessions[0]!, id: "session-recovered", projectId, state: "failed" as const }
  delete recovered.activeTurnId
  delete recovered.providerThreadId
  delete recovered.workspacePath
  delete recovered.baseCommit
  store.sessionCreations.begin({ session: recovered, repositoryPath: "/code/two" })
  const receipt = { path: "/worktrees/session-recovered", branch: "domovoi/session-recovered", baseCommit: "a".repeat(40) }
  store.sessionCreations.complete(recovered.id, receipt)
  const pending = store.sessionCreations.pending.bind(store.sessionCreations)
  vi.spyOn(store.sessionCreations, "pending").mockImplementation((id) => pending(id).map((intent) => ({ ...intent, ownerPid: 2147483647 })))
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const validate = vi.fn(async () => { await waiting; return receipt })
  workspaceService.validateCreatedSessionWorkspace = validate
  const opening = openProject("/code/two")
  await expect.poll(() => validate.mock.calls.length).toBe(1)
  emit({ type: "text-delta", threadId: "provider-thread-1", turnId: "provider-turn-1", delta: "streaming" })
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  expect((await opening).error).toBeUndefined()
  const snapshot = (await rpc("workspace.get", {})).result as unknown as WorkspaceSnapshot
  expect(snapshot.sessions.map((session) => session.id)).toEqual(expect.arrayContaining([sessionId, recovered.id]))
  expect(snapshot.thread).toContainEqual(expect.objectContaining({ sessionId, kind: "assistant", body: "A kept streaming" }))
})

it("keeps terminals across opens and emergency-stops every active project", async () => {
  const { rpc, openProject, agent, terminal } = await fixture()
  const sessions = []
  for (const path of ["/code/one", "/code/two"]) {
    expect((await openProject(path)).error).toBeUndefined()
    const created = await rpc("session.create", { title: path, runtime, client: "desktop" })
    const sessionId = created.result!.activeSessionId as string
    sessions.push(sessionId)
    expect((await rpc("session.send", { sessionId, prompt: "work", client: "desktop" })).error).toBeUndefined()
    expect((await rpc("terminal.create", { terminalId: `terminal-${sessions.length}`, sessionId, cols: 80, rows: 24, client: "desktop", clientId: "desktop-queued-switch" })).error).toBeUndefined()
  }
  expect(terminal.kill).not.toHaveBeenCalled()
  expect(agent.stopThread).not.toHaveBeenCalled()
  const stopped = await rpc("system.emergencyStop", { client: "desktop" })
  expect(stopped.error).toBeUndefined()
  expect(stopped.result).toMatchObject({ outcomes: { turnsStopped: 2, terminalsClosed: 2 }, failures: [] })
  expect(agent.interruptTurn).toHaveBeenCalledWith("provider-thread-1", "provider-turn-1")
  expect(agent.interruptTurn).toHaveBeenCalledWith("provider-thread-2", "provider-turn-2")
  expect(terminal.kill).toHaveBeenCalledTimes(2)
})

it("routes A's checkpoint, evidence and commit while B is focused", async () => {
  const { rpc, openProject, workspaceService } = await fixture()
  await openProject("/code/one")
  const created = await rpc("session.create", { title: "A", runtime, client: "desktop" })
  const sessionId = created.result!.activeSessionId as string
  await openProject("/code/two")
  const checkpoint = vi.spyOn(workspaceService, "checkpoint")
  workspaceService.evidence = vi.fn(async () => ({ baseCommit: "a".repeat(40), diff: "", diffTruncated: false, totalChangedFiles: 0, files: [], filesTruncated: false }))
  workspaceService.commit = vi.fn(async () => ({ commit: "b".repeat(40), branch: `domovoi/${sessionId}`, changedFiles: ["file.ts"] }))
  expect((await rpc("checkpoint.create", { sessionId, label: "A", client: "desktop" })).error).toBeUndefined()
  expect(checkpoint).toHaveBeenCalledWith(`/worktrees/${sessionId}`, "A", expect.any(AbortSignal))
  expect((await rpc("session.evidence", { sessionId })).error).toBeUndefined()
  expect(workspaceService.evidence).toHaveBeenCalledWith(`/worktrees/${sessionId}`, expect.any(AbortSignal))
  expect((await rpc("session.commit", { sessionId, message: "A", expectedHead: "a".repeat(40), expectedChangesDigest: `sha256:${"a".repeat(64)}`, client: "desktop" })).error).toBeUndefined()
  expect(workspaceService.commit).toHaveBeenCalledWith(`/worktrees/${sessionId}`, expect.objectContaining({ repositoryPath: "/code/one", sessionId }), expect.any(AbortSignal))
  expect((await rpc("workspace.get", {})).result).toMatchObject({ project: { path: "/code/two" } })
})

it("marks a removed project folder unavailable before admitting its next turn", async () => {
  const missing: string[] = []
  const { rpc, openProject, agent } = await fixture(undefined, undefined, missing)
  await openProject("/code/one")
  const created = await rpc("session.create", { title: "A", runtime, client: "desktop" })
  await openProject("/code/two")
  missing.push("/code/one")
  expect((await rpc("session.send", { sessionId: created.result!.activeSessionId, prompt: "work", client: "desktop" })).error?.message).toMatch(/folder.*unavailable/)
  expect((await rpc("workspace.get", {})).result?.projects).toContainEqual(expect.objectContaining({ path: "/code/one", unavailableReason: "folder-missing" }))
  expect(agent.startThread).toHaveBeenCalledTimes(1)
})

it.each([0, 17, 1.5, NaN])("refuses an invalid server cap before opening state: %s", (projectCap) => {
  expect(() => new DomovoiDaemon({ projectCap })).toThrow(/Project cap/)
})
