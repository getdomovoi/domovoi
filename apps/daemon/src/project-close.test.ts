import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmptyWorkspace, demoWorkspace, maximumProjectCloseSessions, protocolVersion, workspaceProjects, workspaceSnapshotSchema, type RpcResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"
import type { ArtifactFileChange } from "./artifact-watcher.js"
import { UsageLedger } from "./usage.js"
import { resolveExecution } from "./execution-resolution.js"
import type { TerminalProcess } from "./terminal.js"

const runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(options: { root?: string; initial?: WorkspaceSnapshot } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "project-close-"))
  const listeners = new Set<(event: AgentEvent) => void>()
  let thread = 0
  let turn = 0
  const stopThread = vi.fn(async (_id: string) => {})
  const startTurn = vi.fn(async () => `turn-${++turn}`)
  const startThread = vi.fn(async () => `thread-${++thread}`)
  const agent = {
    connect: async () => {}, close: async () => {}, listModels: async () => [{
      provider: "claude-code", id: "sonnet", displayName: "Sonnet", description: "Test model",
      supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high", isDefault: true,
    }],
    startThread, resumeThread: vi.fn(async () => {}),
    stopThread, startTurn, interruptTurn: vi.fn(async () => {}), resolveApproval: vi.fn(),
    onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as unknown as AgentAdapter
  const inspect = vi.fn(async (path: string) => ({ root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }))
  const projectDirectoryExists = vi.fn(async () => true)
  const workspaceService = {
    inspect,
    createSessionWorkspace: async (_path: string, id: string) => {
      await mkdir(join(root, id), { recursive: true })
      return { path: join(root, id), branch: `domovoi/${id}`, baseCommit: "a".repeat(40) }
    },
    createSessionWorkspaceFromCheckpoint: async (_path: string, commit: string, id: string) => {
      await mkdir(join(root, id), { recursive: true })
      return { path: join(root, id), branch: `domovoi/${id}`, baseCommit: commit }
    },
    removeSessionWorkspace: async () => {}, checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
  } as unknown as WorkspaceService
  const watchers: Array<{ root: string; stop: ReturnType<typeof vi.fn>; onChange: (change: ArtifactFileChange) => void }> = []
  const terminals: Array<TerminalProcess & { kill: ReturnType<typeof vi.fn>; output: (text: string) => void }> = []
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), options.initial ?? createEmptyWorkspace(demoWorkspace.machine))
  const loaded = store.load()
  vi.spyOn(store, "load").mockReturnValueOnce(loaded)
  const daemon = new DomovoiDaemon({ port: 0, store, profileDirectory: root, projectDirectoryExists,
    agents: { "claude-code": agent }, workspaceService, agentTimeoutMs: 500,
    usageLedger: new UsageLedger(join(root, "usage.sqlite")),
    terminalService: { spawn: () => {
      const exits = new Set<(event: { exitCode: number; signal?: number }) => void>()
      const outputs = new Set<(text: string) => void>()
      const terminal = { process: "test-shell", write: vi.fn(), resize: vi.fn(),
        kill: vi.fn(() => { for (const exit of exits) exit({ exitCode: 0 }) }),
        onData: (listener: (text: string) => void) => { outputs.add(listener); return { dispose: () => { outputs.delete(listener) } } },
        onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => { exits.add(listener); return { dispose: () => { exits.delete(listener) } } },
        output: (text: string) => { for (const output of outputs) output(text) },
      }
      terminals.push(terminal)
      return terminal
    } },
    artifactWatcherFactory: ({ root, onChange }) => {
      const watcher = { root, onChange, start: async () => {}, stop: vi.fn() }
      watchers.push(watcher)
      return watcher
    }, errorSink: () => {},
  })
  cleanups.push(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }) })
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  cleanups.push(async () => { socket.terminate() })
  await once(socket, "open")
  const notifications: Array<{ method: string; params: unknown }> = []
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { method?: string; params?: unknown }
    if (frame.method) notifications.push({ method: frame.method, params: frame.params })
  })
  let sequence = 0
  async function rpc<T = WorkspaceSnapshot>(method: string, params: Record<string, unknown> = {}) {
    const id = ++sequence
    return new Promise<{ result?: T; error?: { code: number; message: string; data?: unknown } }>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.off("message", receive); reject(new Error(`${method} timed out`)) }, 4_000)
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(String(data)) as { id?: number; result?: T; error?: { code: number; message: string; data?: unknown } }
        if (reply.id !== id) return
        clearTimeout(timeout)
        socket.off("message", receive)
        resolve(reply)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  expect((await rpc("system.hello", { client: "desktop", clientId: "close-client", protocolVersion, clientVersion: "0.0.1", authToken: daemon.authToken })).error).toBeUndefined()
  async function open(name: string, session = true) {
    const opened = await rpc("project.open", { path: join(root, name), client: "desktop" })
    expect(opened.error).toBeUndefined()
    const projectId = opened.result!.project!.id
    if (!session) return { projectId, sessionId: "", threadId: "" }
    const created = await rpc("session.create", { title: name, runtime, client: "desktop" })
    expect(created.error).toBeUndefined()
    const current = created.result!.sessions.find((entry) => entry.id === created.result!.activeSessionId)!
    return { projectId, sessionId: current.id, threadId: current.providerThreadId! }
  }
  async function close(projectId: string) {
    const first = await rpc<RpcResult<"project.close">>("project.close", { projectId, client: "desktop" })
    if (!first.error) return first
    expect(first.error.code).toBe(-32022)
    return rpc<RpcResult<"project.close">>("project.close", { projectId, client: "desktop", confirmation: first.error.data })
  }
  return { rpc, open, close, store, loaded, root, daemon, socket, notifications, workspaceService, stopThread, startTurn, startThread, agent, inspect, projectDirectoryExists, watchers, terminals,
    emit: (event: AgentEvent) => { for (const listener of listeners) listener(event) } }
}

it("requires confirmation for idle sessions and rejects a changed session set", async () => {
  const { rpc, open, stopThread } = await fixture()
  const a = await open("a")
  const first = await rpc("project.close", { projectId: a.projectId, client: "desktop" })
  expect(first.error?.code).toBe(-32022)
  expect(stopThread).not.toHaveBeenCalled()
  await rpc("session.create", { title: "another", runtime, client: "desktop" })
  const stale = await rpc("project.close", { projectId: a.projectId, client: "desktop", confirmation: first.error!.data })
  expect(stale.error?.code).toBe(-32022)
  expect(stale.error?.data).toMatchObject({ sessionCount: 2 })
  expect(stopThread).not.toHaveBeenCalled()
})

it("closes a zero-session project without confirmation and validates the empty snapshot", async () => {
  const { rpc, open } = await fixture()
  const a = await open("a", false)
  const closed = await rpc<RpcResult<"project.close">>("project.close", { projectId: a.projectId, client: "desktop" })
  expect(closed.error).toBeUndefined()
  expect(workspaceSnapshotSchema.parse(closed.result!.snapshot)).toMatchObject({ project: null, projects: [], activeSessionId: null })
  expect(closed.result!.sessions).toEqual([])
})

it("closing A leaves B's turn and watcher running and restores A without running work", async () => {
  const { rpc, open, close, stopThread, watchers, store } = await fixture()
  const a = await open("a")
  await rpc("session.send", { sessionId: a.sessionId, prompt: "A", client: "desktop" })
  const b = await open("b")
  await rpc("session.send", { sessionId: b.sessionId, prompt: "B", client: "desktop" })
  const closed = await close(a.projectId)
  expect(closed.error).toBeUndefined()
  expect(closed.result!.sessions).toEqual([{ sessionId: a.sessionId, outcome: "stopped" }])
  expect(closed.result!.snapshot.sessions).toEqual([expect.objectContaining({ id: b.sessionId, activeTurnId: "turn-2" })])
  expect(stopThread.mock.calls).toEqual([[a.threadId]])
  expect(watchers[0]!.stop).toHaveBeenCalledOnce()
  expect(watchers[1]!.stop).not.toHaveBeenCalled()
  expect(workspaceProjects(store.load()).map((project) => project.id)).toEqual([b.projectId])
  expect(store.loadProject(a.projectId)!.sessions[0]).not.toHaveProperty("activeTurnId")
  await open("a", false)
  const reopened = (await rpc("workspace.get")).result!
  expect(reopened.sessions.find((session) => session.id === a.sessionId)).toMatchObject({ state: "idle" })
  expect(reopened.sessions.find((session) => session.id === a.sessionId)).not.toHaveProperty("activeTurnId")
})

it("keeps an unconfirmed stop fenced across close and reopen", async () => {
  const { rpc, open, close, stopThread, startTurn } = await fixture()
  const a = await open("a")
  stopThread.mockRejectedValue(new Error("still alive"))
  const closed = await close(a.projectId)
  expect(closed.error).toBeUndefined()
  expect(closed.result!.sessions).toEqual([{ sessionId: a.sessionId, outcome: "unconfirmed" }])
  await open("a", false)
  const send = await rpc("session.send", { sessionId: a.sessionId, prompt: "again", client: "desktop" })
  expect(send.error?.message).toContain("requires recovery")
  expect(startTurn).not.toHaveBeenCalled()
  stopThread.mockResolvedValue()
})

it("moves focus by focus recency rather than opening order", async () => {
  const { rpc, open, close } = await fixture()
  const a = await open("a")
  const b = await open("b")
  const c = await open("c")
  expect((await rpc("session.activate", { sessionId: a.sessionId, client: "desktop" })).error).toBeUndefined()
  expect((await rpc("session.activate", { sessionId: c.sessionId, client: "desktop" })).error).toBeUndefined()
  expect((await close(c.projectId)).result!.snapshot.project?.id).toBe(a.projectId)
  expect((await close(a.projectId)).result!.snapshot.project?.id).toBe(b.projectId)
  expect(workspaceSnapshotSchema.parse((await close(b.projectId)).result!.snapshot).projects).toEqual([])
})

it.each(["folder-missing", "folder-check-failed"] as const)("closes a %s project without inspecting its folder", async (reason) => {
  const { rpc, open, close, inspect, projectDirectoryExists } = await fixture()
  const a = await open("a")
  if (reason === "folder-missing") projectDirectoryExists.mockResolvedValue(false)
  else projectDirectoryExists.mockRejectedValue(new Error("mount hung"))
  await rpc("session.send", { sessionId: a.sessionId, prompt: "blocked", client: "desktop" })
  expect((await rpc("workspace.get")).result!.project!.unavailableReason).toBe(reason)
  inspect.mockClear()
  projectDirectoryExists.mockClear()
  expect((await close(a.projectId)).error).toBeUndefined()
  expect(inspect).not.toHaveBeenCalled()
  expect(projectDirectoryExists).not.toHaveBeenCalled()
})

it("drops content, approval and tool events from a closed thread, including after reopen", async () => {
  const { rpc, open, close, emit } = await fixture()
  const a = await open("a")
  await close(a.projectId)
  const late = () => {
    emit({ type: "text-delta", threadId: a.threadId, delta: "late content" })
    emit({ type: "approval-requested", threadId: a.threadId, requestId: 42, command: "echo late" })
    emit({ type: "command-output", threadId: a.threadId, delta: "late tool output" })
  }
  late()
  expect((await rpc("workspace.get")).result!.sessions).toEqual([])
  await open("a", false)
  late()
  const snapshot = (await rpc("workspace.get")).result!
  expect(snapshot.approvals).toEqual([])
  expect(JSON.stringify(snapshot.thread)).not.toContain("late content")
  expect(JSON.stringify(snapshot.thread)).not.toContain("late tool output")
})

it("preserves B's terminal, watcher, redactor and queued send when A closes", async () => {
  const { rpc, open, close, emit, terminals, watchers, store, notifications } = await fixture()
  const a = await open("a")
  const b = await open("b")
  for (const session of [a, b]) {
    expect((await rpc("session.send", { sessionId: session.sessionId, prompt: "work", client: "desktop" })).error).toBeUndefined()
    expect((await rpc("session.send", { sessionId: session.sessionId, prompt: "next", delivery: "next-turn-replace", client: "desktop" })).error).toBeUndefined()
    expect((await rpc("terminal.create", { terminalId: `terminal-${session.sessionId}`, sessionId: session.sessionId,
      cols: 80, rows: 24, client: "desktop", clientId: "close-client" })).error).toBeUndefined()
    emit({ type: "command-output", threadId: session.threadId, itemId: `tool-${session.sessionId}`, delta: "token=" })
  }
  await rpc("workspace.get")
  expect((await close(a.projectId)).error).toBeUndefined()
  expect(terminals[0]!.kill).toHaveBeenCalledOnce()
  expect(terminals[1]!.kill).not.toHaveBeenCalled()
  terminals[1]!.output("B is alive\n")
  await expect.poll(() => notifications).toContainEqual({ method: "terminal.output", params: { terminalId: `terminal-${b.sessionId}`, data: "B is alive\n" } })
  expect(watchers[1]!.stop).not.toHaveBeenCalled()
  await writeFile(join(watchers[1]!.root, "plan.md"), "B's plan")
  watchers[1]!.onChange({ path: "plan.md", title: "B plan", type: "plan", mimeType: "text/markdown", content: "B's plan" })
  emit({ type: "command-output", threadId: b.threadId, itemId: `tool-${b.sessionId}`, delta: "synthetic-test-secret\n" })
  emit({ type: "turn-completed", params: { threadId: b.threadId, turnId: "turn-2", status: "completed" } })
  await expect.poll(async () => (await rpc("workspace.get")).result!.queuedSends?.find((send) => send.sessionId === b.sessionId)?.state).toBe("delivered")
  const snapshot = (await rpc("workspace.get")).result!
  expect(snapshot.artifacts).toContainEqual(expect.objectContaining({ sessionId: b.sessionId, title: "B plan" }))
  expect(snapshot.thread).toContainEqual(expect.objectContaining({ sessionId: b.sessionId, kind: "tool", output: expect.stringContaining("token=[REDACTED]") }))
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-test-secret")
  expect(store.loadQueuedSessionSends().find((send) => send.sessionId === a.sessionId)).toMatchObject({ state: "held", reason: "Project close held the queued send." })
})

it("finishes close after emergency stop aborts it mid-stop, with no half-active project", async () => {
  const { rpc, open, close, stopThread } = await fixture()
  const a = await open("a")
  const b = await open("b")
  for (const session of [a, b]) await rpc("session.send", { sessionId: session.sessionId, prompt: "work", client: "desktop" })
  const entered = deferred()
  const stopped = deferred()
  stopThread.mockImplementationOnce(async () => { entered.resolve(); await stopped.promise })
  const closing = close(a.projectId)
  await entered.promise
  const emergency = await rpc("system.emergencyStop", { client: "desktop" })
  expect(emergency.error).toBeUndefined()
  stopped.resolve()
  expect((await closing).error).toBeUndefined()
  const final = workspaceSnapshotSchema.parse((await rpc("workspace.get")).result)
  expect(final.projects!.map((project) => project.id)).toEqual([b.projectId])
  expect(final.sessions).toEqual([expect.objectContaining({ id: b.sessionId, state: "idle" })])
  expect(final.sessions[0]).not.toHaveProperty("activeTurnId")
})

it.each(["create", "fork"] as const)("waits for in-flight session.%s and renews the affected-session confirmation", async (operation) => {
  const { rpc, open, startThread } = await fixture()
  const a = await open("a")
  const original = await rpc("project.close", { projectId: a.projectId, client: "desktop" })
  const checkpoint = (await rpc("workspace.get")).result!.thread.find((item) => item.sessionId === a.sessionId && item.kind === "checkpoint")!
  const entered = deferred()
  const started = deferred()
  startThread.mockImplementationOnce(async () => { entered.resolve(); await started.promise; return "created-while-closing" })
  const creation = operation === "create"
    ? rpc("session.create", { title: "second", runtime, projectId: a.projectId, client: "desktop" })
    : rpc("session.fork", { sessionId: a.sessionId, checkpointId: checkpoint.id, requestId: "close-fork", runtime, client: "desktop" })
  await entered.promise
  const closing = rpc("project.close", { projectId: a.projectId, client: "desktop", confirmation: original.error!.data })
  started.resolve()
  expect((await creation).error).toBeUndefined()
  expect((await closing).error).toMatchObject({ code: -32022, data: { sessionCount: 2 } })
})

it("leaves a stopped project active when the atomic close write fails", async () => {
  const { rpc, open, close, store } = await fixture()
  const a = await open("a")
  vi.spyOn(store, "saveProjectCloseAsync").mockRejectedValueOnce(new Error("injected disk failure"))
  expect((await close(a.projectId)).error).toBeDefined()
  const snapshot = workspaceSnapshotSchema.parse((await rpc("workspace.get")).result)
  expect(snapshot.project?.id).toBe(a.projectId)
  expect(snapshot.sessions[0]).not.toHaveProperty("activeTurnId")
  expect((await close(a.projectId)).error).toBeUndefined()
})

it("rejects callbacks from a stopped watcher after reopen while accepting the replacement", async () => {
  const { rpc, open, close, watchers } = await fixture()
  const a = await open("a")
  const old = watchers[0]!
  await writeFile(join(old.root, "plan.md"), "plan")
  expect((await close(a.projectId)).error).toBeUndefined()
  await open("a", false)
  const change: ArtifactFileChange = { path: "plan.md", title: "stale plan", type: "plan", mimeType: "text/markdown", content: "stale" }
  old.onChange(change)
  expect((await rpc("workspace.get")).result!.artifacts).toEqual([])
  watchers.at(-1)!.onChange({ ...change, title: "current plan", content: "current" })
  await expect.poll(async () => (await rpc("workspace.get")).result!.artifacts.map((artifact) => artifact.title)).toEqual(["current plan"])
})

it("waits for an emergency before claiming close and renews the confirmation", async () => {
  const { rpc, open, stopThread, agent } = await fixture()
  const a = await open("a")
  await rpc("session.send", { sessionId: a.sessionId, prompt: "work", client: "desktop" })
  const initial = await rpc("project.close", { projectId: a.projectId, client: "desktop" })
  const entered = deferred()
  const stopped = deferred()
  vi.mocked(agent.interruptTurn).mockImplementationOnce(async () => { entered.resolve(); await stopped.promise })
  const emergency = rpc("system.emergencyStop", { client: "desktop" })
  await entered.promise
  const closing = rpc("project.close", { projectId: a.projectId, client: "desktop", confirmation: initial.error!.data })
  stopped.resolve()
  expect((await emergency).error).toBeUndefined()
  expect((await closing).error).toMatchObject({ code: -32022 })
  expect(stopThread).not.toHaveBeenCalled()
  expect((await rpc("workspace.get")).result!.project!.id).toBe(a.projectId)
})

it("preserves an emergency stop of B while A's atomic close write is in flight", async () => {
  const { rpc, open, close, store, agent } = await fixture()
  const a = await open("a")
  const b = await open("b")
  await rpc("session.send", { sessionId: b.sessionId, prompt: "work", client: "desktop" })
  const entered = deferred()
  const persist = deferred()
  const save = store.saveProjectCloseAsync.bind(store)
  vi.spyOn(store, "saveProjectCloseAsync").mockImplementationOnce(async (...args) => {
    entered.resolve()
    await persist.promise
    await save(...args)
  })
  const closing = close(a.projectId)
  await entered.promise
  const emergency = rpc("system.emergencyStop", { client: "desktop" })
  await expect.poll(() => vi.mocked(agent.interruptTurn).mock.calls.some(([id]) => id === b.threadId)).toBe(true)
  persist.resolve()
  expect((await closing).error).toBeUndefined()
  expect((await emergency).error).toBeUndefined()
  const live = workspaceSnapshotSchema.parse((await rpc("workspace.get")).result)
  for (const snapshot of [live, store.load()]) {
    expect(workspaceProjects(snapshot).map((project) => project.id)).toEqual([b.projectId])
    expect(snapshot.sessions).toEqual([expect.objectContaining({ id: b.sessionId, state: "idle" })])
    expect(snapshot.sessions[0]).not.toHaveProperty("activeTurnId")
  }
})

it("keeps the close claim through a terminal wait and refuses queued creation in the closed project", async () => {
  const { rpc, open, close, terminals, stopThread, startThread } = await fixture()
  const a = await open("a")
  await rpc("terminal.create", { terminalId: "a-terminal", sessionId: a.sessionId, cols: 80, rows: 24, client: "desktop", clientId: "close-client" })
  const terminal = terminals[0]!
  const finish = terminal.kill.getMockImplementation()! as () => void
  const entered = deferred()
  terminal.kill.mockImplementation(() => { entered.resolve() })
  const closing = close(a.projectId)
  await entered.promise
  await expect.poll(() => stopThread.mock.calls.length).toBe(1)
  expect((await rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
  const creation = rpc("session.create", { title: "late", projectId: a.projectId, runtime, client: "desktop" })
  finish()
  expect((await closing).error).toBeUndefined()
  expect((await creation).error).toBeDefined()
  expect(startThread).toHaveBeenCalledOnce()
  expect(stopThread).toHaveBeenCalledOnce()
})

it("saves rules, expires approvals with an audit, and restores held sends and ended turns after restart", async () => {
  const first = await fixture()
  const a = await first.open("a")
  const b = await first.open("b")
  await first.close(a.projectId)
  const saved = first.store.loadProject(a.projectId)!
  const execution = await resolveExecution({ workspaceRoot: saved.sessions[0]!.workspacePath!, cwd: saved.sessions[0]!.workspacePath!, command: "echo rule" })
  if (execution.state !== "resolved") throw new Error("Test rule must resolve")
  saved.approvalRules = [{ id: "rule-kept", projectId: a.projectId, operation: "Test rule", command: "echo rule", status: "active", execution,
    createdBy: "desktop", createdAt: new Date().toISOString(), useCount: 0 }]
  first.store.saveProjectClose(first.store.load(), { ...createEmptyWorkspace(demoWorkspace.machine), ...saved })
  await first.open("a", false)
  await first.rpc("session.send", { sessionId: a.sessionId, prompt: "work", client: "desktop" })
  await first.rpc("session.send", { sessionId: a.sessionId, prompt: "held", delivery: "next-turn-replace", client: "desktop" })
  first.emit({ type: "approval-requested", threadId: a.threadId, requestId: 99, command: "rm important-file" })
  await expect.poll(async () => (await first.rpc("workspace.get")).result!.approvals.length).toBe(1)
  const approval = (await first.rpc("workspace.get")).result!.approvals[0]!
  expect((await first.close(a.projectId)).error).toBeUndefined()
  const audit = first.store.auditLog.query({ limit: 100 })
  expect(audit.entries).toContainEqual(expect.objectContaining({ action: "approval.expired", target: approval.id, sessionId: a.sessionId, projectId: a.projectId, actor: { kind: "daemon", component: "project-close" } }))
  expect(first.store.loadProject(a.projectId)!.approvalRules).toEqual(saved.approvalRules)
  expect(first.store.loadProject(a.projectId)!.approvals).toEqual([])
  first.socket.terminate()
  await first.daemon.stop()
  const restarted = await fixture({ root: first.root })
  expect((await restarted.rpc("workspace.get")).result!.project!.id).toBe(b.projectId)
  await restarted.open("a", false)
  const reopened = (await restarted.rpc("workspace.get")).result!
  expect(reopened.approvalRules).toEqual(saved.approvalRules)
  expect(reopened.approvals).toEqual([])
  expect(reopened.sessions.find((session) => session.id === a.sessionId)).toMatchObject({ state: "idle" })
  expect(reopened.sessions.find((session) => session.id === a.sessionId)).not.toHaveProperty("activeTurnId")
  expect(reopened.queuedSends).toContainEqual(expect.objectContaining({ sessionId: a.sessionId, state: "held" }))
  expect(reopened.turns).toContainEqual(expect.objectContaining({ sessionId: a.sessionId, status: "interrupted", completedAt: expect.any(String) }))
  expect(restarted.startThread).not.toHaveBeenCalled()
  expect(restarted.startTurn).not.toHaveBeenCalled()
})

it("keeps unconfirmed fences through reopen but a new daemon clears only the in-memory fence", async () => {
  const first = await fixture()
  const a = await first.open("a")
  first.stopThread.mockRejectedValue(new Error("old provider still alive"))
  expect((await first.close(a.projectId)).result!.sessions).toEqual([{ sessionId: a.sessionId, outcome: "unconfirmed" }])
  await first.open("a", false)
  expect((await first.rpc("session.send", { sessionId: a.sessionId, prompt: "blocked", client: "desktop" })).error).toBeDefined()
  first.socket.terminate()
  await first.daemon.stop()
  const restarted = await fixture({ root: first.root })
  // Reconstruction does not ask the old adapter to prove that its process exited.
  first.stopThread.mockClear()
  expect((await restarted.rpc("session.send", { sessionId: a.sessionId, prompt: "explicit send", client: "desktop" })).error).toBeUndefined()
  expect(restarted.startTurn).toHaveBeenCalledOnce()
  expect(first.stopThread).not.toHaveBeenCalled()
})

it("preserves focus when closing an unfocused project immediately after reconstruction", async () => {
  const first = await fixture()
  const a = await first.open("a")
  const b = await first.open("b")
  await first.rpc("session.activate", { sessionId: a.sessionId, client: "desktop" })
  first.socket.terminate()
  await first.daemon.stop()
  const restarted = await fixture({ root: first.root })
  expect((await restarted.close(b.projectId)).result!.snapshot.project!.id).toBe(a.projectId)
})


it.each(["added", "retargeted"] as const)("renews confirmation for an injected %s session after a close await", async (change) => {
  const initial = createEmptyWorkspace(demoWorkspace.machine)
  initial.project = demoWorkspace.project
  const session = { ...demoWorkspace.sessions[0]!, state: "idle" as const, runtime: { ...runtime, permissionMode: "build" as const }, workspacePath: "/synthetic/close" }
  delete session.activeTurnId
  delete session.providerThreadId
  initial.sessions = [session]
  const { rpc, loaded, terminals, store } = await fixture({ initial })
  const projectId = initial.project!.id
  await rpc("terminal.create", { terminalId: "paused-exit", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "close-client" })
  const terminal = terminals[0]!
  const finish = terminal.kill.getMockImplementation()! as () => void
  const entered = deferred()
  terminal.kill.mockImplementation(() => { entered.resolve() })
  const confirmation = (await rpc("project.close", { projectId, client: "desktop" })).error!.data
  const closing = rpc("project.close", { projectId, client: "desktop", confirmation })
  await entered.promise
  // Inject an out-of-band writer at the store boundary. Normal RPC and
  // transfer writers are excluded by the queue, but close must fail safely
  // if a background writer changes the set while terminal shutdown awaits.
  if (change === "added") loaded.sessions.push({ ...session, id: "new-session", title: "New session" })
  else loaded.sessions[0]!.workspacePath = "/synthetic/changed"
  finish()
  expect((await closing).error).toMatchObject({ code: -32022 })
  expect((await rpc("workspace.get")).result!.project!.id).toBe(projectId)
  expect(store.load().project!.id).toBe(projectId)
})


it("rejects old queued events after close, reopen and a new send while accepting new events", async () => {
  const { rpc, open, root, emit, workspaceService, watchers } = await fixture()
  const a = await open("a")
  const confirmation = (await rpc("project.close", { projectId: a.projectId, client: "desktop" })).error!.data
  const entered = deferred()
  const release = deferred()
  vi.spyOn(workspaceService, "checkpoint").mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { commit: "c".repeat(40), changedFiles: [] }
  })
  const checkpoint = rpc("checkpoint.create", { sessionId: a.sessionId, client: "desktop" })
  await entered.promise
  const closing = rpc("project.close", { projectId: a.projectId, client: "desktop", confirmation })
  const reopening = rpc("project.open", { path: join(root, "a"), client: "desktop" })
  const sending = rpc("session.send", { sessionId: a.sessionId, prompt: "new turn", client: "desktop" })
  // This read bypasses the mutation queue and proves the preceding socket
  // requests were dispatched before these old events enter the queue.
  await rpc("permission.hardGates")
  emit({ type: "text-delta", threadId: a.threadId, delta: "old queued text" })
  emit({ type: "approval-requested", threadId: a.threadId, requestId: 100, command: "rm old-queued-file" })
  emit({ type: "command-output", threadId: a.threadId, delta: "old queued tool output" })
  await writeFile(join(watchers[0]!.root, "old.md"), "old queued artifact")
  watchers[0]!.onChange({ path: "old.md", type: "plan", title: "old queued artifact", mimeType: "text/markdown", content: "old" })
  release.resolve()
  for (const result of await Promise.all([checkpoint, closing, reopening, sending])) expect(result.error).toBeUndefined()
  const snapshot = (await rpc("workspace.get")).result!
  expect(snapshot.approvals).toEqual([])
  expect(snapshot.artifacts).toEqual([])
  expect(JSON.stringify(snapshot.thread)).not.toContain("old queued")
  emit({ type: "text-delta", threadId: a.threadId, delta: "current text" })
  await expect.poll(async () => JSON.stringify((await rpc("workspace.get")).result!.thread)).toContain("current text")
})

it("caps the stop report without leaving omitted sessions active or unsaved", async () => {
  const initial = createEmptyWorkspace(demoWorkspace.machine)
  initial.project = demoWorkspace.project
  initial.sessions = Array.from({ length: maximumProjectCloseSessions + 1 }, (_, index) => {
    const session = { ...demoWorkspace.sessions[0]!, id: `session-cap-${index}`, title: `Session ${index}`, state: "idle" as const }
    delete session.activeTurnId
    delete session.providerThreadId
    delete session.workspacePath
    return session
  })
  const { close, store } = await fixture({ initial })
  const closed = await close(initial.project!.id)
  expect(closed.error).toBeUndefined()
  expect(closed.result!.sessions).toHaveLength(maximumProjectCloseSessions)
  expect(closed.result!.omittedSessions).toBe(1)
  expect(closed.result!.snapshot.sessions).toEqual([])
  expect(store.loadProject(initial.project!.id)!.sessions).toHaveLength(maximumProjectCloseSessions + 1)
})
