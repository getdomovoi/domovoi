import { once } from "node:events"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { RepositoryTrustGrant, RepositoryTrustStore } from "./repository-trust-store.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

// Slice P6a: every call that opens a provider thread or starts a turn carries
// this machine's grant for the session's repository, looked up at that call and
// never kept from an earlier answer. The adapter decides with it
// (repository-trust-apply.ts). Archive resume carries none (ruling Q149 A).

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const projectId = "project-acme"
const claude: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
const codex: Runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "high", permissionMode: "build", auto: false }

const grant = (digit: string): RepositoryTrustGrant => ({
  projectId, trustedDigest: `sha256:${digit.repeat(64)}`, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" },
})

function agentFor(runtime: Runtime, threadId: string) {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{
      provider: runtime.provider, id: runtime.model, displayName: runtime.model, description: "",
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high", isDefault: true,
    }]),
    startThread: vi.fn(async (_input: Parameters<AgentAdapter["startThread"]>[0]) => threadId),
    resumeThread: vi.fn(async (_input: Parameters<AgentAdapter["resumeThread"]>[0]) => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => `turn-${threadId}`),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
}

function session(id: string, runtime: Runtime, thread?: string): WorkspaceSnapshot["sessions"][number] {
  return {
    id, projectId, title: id, state: "idle", runtime, changedFiles: 0, testsPassed: 0, testsFailed: 0,
    updatedAt: "2026-09-29T12:00:00.000Z", workspacePath: `/worktrees/${id}`, ...(thread ? { providerThreadId: thread } : {}),
  }
}

async function fixture() {
  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: "/code/acme", branch: "main" },
    sessions: [
      session("session-send", claude, "thread-send"),
      session("session-other", claude, "thread-other"),
      session("session-restart", claude),
      session("session-handoff", codex, "thread-handoff"),
      session("session-archive", claude, "thread-archive"),
    ],
  }
  snapshot.thread.push({
    id: "checkpoint-fork", sessionId: "session-send", kind: "checkpoint", label: "88888888 · fork point",
    commit: "8".repeat(40), createdAt: "2026-09-29T12:00:00.000Z",
  })
  // The trust store as the server sees it: whatever grant is on record at
  // the moment it asks, and every project id it asks for.
  const trust = { current: undefined as RepositoryTrustGrant | undefined, asked: [] as string[], fails: false }
  const repositoryTrust: RepositoryTrustStore = {
    find: (id) => {
      trust.asked.push(id)
      if (trust.fails) throw new Error("database is locked")
      return trust.current
    },
    record: vi.fn(),
    revoke: vi.fn(),
  }
  const workspaceService = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "acme", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40) })),
    createSessionWorkspaceFromCheckpoint: vi.fn(async (_path: string, commit: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: commit })),
    removeSessionWorkspace: vi.fn(async () => {}),
    archiveSessionWorkspace: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    restore: vi.fn(),
  } satisfies WorkspaceService
  const agents = { "claude-code": agentFor(claude, "claude-thread"), codex: agentFor(codex, "codex-thread") }
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({
    port: 0, statePath: ":memory:", store: new SqliteWorkspaceStore(":memory:", snapshot), agents, workspaceService, repositoryTrust, errorSink,
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    const id = ++nextId
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: number }
      if (message.id !== id) return
      socket.off("message", receive)
      resolve(message as Record<string, unknown>)
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect(await rpc("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).toHaveProperty("result")
  const ok = async (method: string, params: Record<string, unknown>) => {
    const reply = await rpc(method, { client: "desktop", ...params })
    expect(reply, method).not.toHaveProperty("error")
    return reply
  }
  return { agents, trust, ok, errorSink }
}

const trustOf = (call: object | undefined) => (call as { repositoryTrust?: unknown } | undefined)?.repositoryTrust

describe("the grant each provider call carries", () => {
  it("looks the grant up at every resume and turn, so a changed grant reaches the next call", async () => {
    const { agents, trust, ok } = await fixture()
    trust.current = grant("a")
    await ok("session.send", { sessionId: "session-send", prompt: "first" })
    expect(trustOf(agents["claude-code"].resumeThread.mock.calls[0]![0])).toEqual(grant("a"))
    expect(trustOf(agents["claude-code"].startTurn.mock.calls[0]![0])).toEqual(grant("a"))

    trust.current = grant("b")
    await ok("session.send", { sessionId: "session-other", prompt: "second" })
    expect(trustOf(agents["claude-code"].resumeThread.mock.calls[1]![0])).toEqual(grant("b"))
    expect(trustOf(agents["claude-code"].startTurn.mock.calls[1]![0])).toEqual(grant("b"))
    expect(trust.asked.every((id) => id === projectId)).toBe(true)
  })

  it("carries no grant once none is on record", async () => {
    const { agents, trust, ok } = await fixture()
    await ok("session.send", { sessionId: "session-send", prompt: "untrusted" })
    expect(agents["claude-code"].resumeThread.mock.calls[0]![0]).not.toHaveProperty("repositoryTrust")
    expect(agents["claude-code"].startTurn.mock.calls[0]![0]).not.toHaveProperty("repositoryTrust")
    expect(trust.asked).toEqual([projectId, projectId])
  })

  it("reports a trust store that fails and carries no grant, so the session opens held back", async () => {
    const { agents, trust, ok, errorSink } = await fixture()
    trust.current = grant("e")
    trust.fails = true
    await ok("session.send", { sessionId: "session-send", prompt: "store down" })
    expect(agents["claude-code"].startTurn.mock.calls[0]![0]).not.toHaveProperty("repositoryTrust")
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({ context: "Domovoi could not read repository trust" }))
  })

  it("carries the grant when a session starts, restarts, forks or hands off", async () => {
    const { agents, trust, ok } = await fixture()
    trust.current = grant("c")
    await ok("session.create", { title: "new", runtime: claude })
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    await ok("session.fork", { sessionId: "session-send", checkpointId: "checkpoint-fork", requestId: "fork-with-grant", runtime: claude })
    await ok("session.setRuntime", { sessionId: "session-handoff", runtime: claude })
    const started = agents["claude-code"].startThread.mock.calls.map(([input]) => trustOf(input))
    expect(started).toEqual([grant("c"), grant("c"), grant("c"), grant("c")])
  })

  // Ruling Q149 A: a thread resumed only to be stopped for an archive never
  // runs under trust.
  it("carries no grant on the resume an archive makes", async () => {
    const { agents, trust, ok } = await fixture()
    trust.current = grant("d")
    await ok("session.archive", { sessionId: "session-archive" })
    expect(agents["claude-code"].resumeThread).toHaveBeenCalledOnce()
    expect(agents["claude-code"].resumeThread.mock.calls[0]![0]).not.toHaveProperty("repositoryTrust")
    expect(agents["claude-code"].stopThread).toHaveBeenCalledWith("thread-archive")
  })
})
