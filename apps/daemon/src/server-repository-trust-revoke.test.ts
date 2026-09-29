import { createHash } from "node:crypto"
import { once } from "node:events"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { RepositoryProviderConfig } from "./repository-provider-config.js"
import type { RepositoryTrustGrant, RepositoryTrustStore } from "./repository-trust-store.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

// Slice P6d: taking repository trust back stops, at once, every provider
// thread whose adapter reported that it loaded trusted configuration (rulings
// Q4, Q146, Q170 A). Each is reported restarted when its stop resolved and
// unconfirmed otherwise (Q152 A); an unconfirmed session is failed and fenced
// as an emergency stop fences one. Nothing resumes on its own: the next
// message resumes the thread without the repository's configuration.
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const projectId = "project-acme"
const digest = `sha256:${"a".repeat(64)}`
const claude: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
const codex: Runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "high", permissionMode: "build", auto: false }

const grant = (id: string): RepositoryTrustGrant => ({
  projectId: id, trustedDigest: digest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" },
})

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

// A stub that reports applied trust (as P6b and P6c will) loads trusted
// configuration on every thread a grant reaches. One that does not report has
// no repositoryTrustApplied at all, like every adapter in this slice.
function agentFor(runtime: Runtime, reportsTrust: boolean) {
  const listeners = new Set<(event: AgentEvent) => void>()
  const applied = new Map<string, string>()
  const apply = (threadId: string, trust: RepositoryTrustGrant | undefined) => {
    if (trust) applied.set(threadId, trust.trustedDigest)
  }
  const adapter = {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{
      provider: runtime.provider, id: runtime.model, displayName: runtime.model, description: "",
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high", isDefault: true,
    }]),
    startThread: vi.fn(async (input: Parameters<AgentAdapter["startThread"]>[0]) => {
      const threadId = `${runtime.provider}-started`
      apply(threadId, input.repositoryTrust)
      return threadId
    }),
    resumeThread: vi.fn(async (input: Parameters<AgentAdapter["resumeThread"]>[0]) => {
      apply(input.threadId, input.repositoryTrust)
    }),
    stopThread: vi.fn(async (threadId: string) => {
      applied.delete(threadId)
    }),
    startTurn: vi.fn(async (input: Parameters<AgentAdapter["startTurn"]>[0]) => {
      apply(input.threadId, input.repositoryTrust)
      return `turn-${input.threadId}`
    }),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async (_threadId: string, _turnId: string) => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  if (!reportsTrust) return adapter
  return {
    ...adapter,
    repositoryTrustApplied: vi.fn((threadId: string) => {
      const digest = applied.get(threadId)
      return digest === undefined ? undefined : { digest }
    }),
  } satisfies AgentAdapter
}

function session(id: string, runtime: Runtime, thread?: string): WorkspaceSnapshot["sessions"][number] {
  return {
    id, projectId, title: id, state: "idle", runtime, changedFiles: 0, testsPassed: 0, testsFailed: 0,
    updatedAt: "2026-09-29T12:00:00.000Z", workspacePath: `/worktrees/${id}`, ...(thread ? { providerThreadId: thread } : {}),
  }
}

async function fixture(options: { agentTimeoutMs?: number; reportsTrust?: boolean } = {}) {
  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: "/code/acme", branch: "main" },
    sessions: [
      session("session-a", claude, "thread-a"),
      session("session-b", claude, "thread-b"),
      session("session-codex", codex, "thread-codex"),
      session("session-restart", claude),
    ],
  }
  // Grants by project, as the store holds them.
  const grants = new Map<string, RepositoryTrustGrant>()
  const repositoryTrust: RepositoryTrustStore = {
    find: (id) => grants.get(id),
    record: vi.fn(),
    revoke: vi.fn((id: string) => { grants.delete(id) }),
  }
  const config: RepositoryProviderConfig = { configDigest: digest, providers: [], trustRefusals: [], documents: {} }
  const workspaceService = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "acme", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40) })),
    createSessionWorkspaceFromCheckpoint: vi.fn(async (_path: string, commit: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: commit })),
    removeSessionWorkspace: vi.fn(async () => {}),
    archiveSessionWorkspace: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    restore: vi.fn(),
  } satisfies WorkspaceService
  const reportsTrust = options.reportsTrust ?? true
  const agents = { "claude-code": agentFor(claude, reportsTrust), codex: agentFor(codex, reportsTrust) }
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({
    port: 0,
    statePath: ":memory:",
    store: new SqliteWorkspaceStore(":memory:", snapshot),
    agents,
    workspaceService,
    repositoryTrust,
    repositoryProviderConfig: async () => config,
    errorSink,
    ...(options.agentTimeoutMs ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
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
  const revoke = async (id = projectId) => {
    const reply = await ok("repository.revokeTrust", { projectId: id })
    return (reply.result as { threads: unknown[] }).threads
  }
  const live = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  const sessionNamed = async (id: string) => (await live()).sessions.find((candidate) => candidate.id === id)!
  const notices = async (id: string) => (await live()).thread
    .filter((item) => item.sessionId === id && item.kind === "system")
    .map((item) => (item as { body: string }).body)
  return { agents, grants, rpc, ok, revoke, sessionNamed, notices, errorSink }
}

const trustOf = (call: object | undefined) => (call as { repositoryTrust?: unknown } | undefined)?.repositoryTrust
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe("repository.revokeTrust stops the threads that opened under the grant", () => {
  it("reports no threads when none opened under it", async () => {
    const { agents, grants, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    expect(await revoke()).toEqual([])
    expect(agents["claude-code"].stopThread).not.toHaveBeenCalled()
    expect(grants.has(projectId)).toBe(false)
  })

  it("stops an idle thread, reports it restarted, and the next message resumes it without the grant", async () => {
    const { agents, grants, ok, revoke, sessionNamed, notices } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    expect(trustOf(agents["claude-code"].startThread.mock.calls[0]![0])).toEqual(grant(projectId))

    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "restarted" }])
    expect(agents["claude-code"].interruptTurn).not.toHaveBeenCalled()
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"]])
    const stopped = await sessionNamed("session-restart")
    expect(stopped).toMatchObject({ state: "idle", providerThreadId: "claude-code-started" })
    expect(await notices("session-restart")).toContain("Repository trust was taken back, so the agent was stopped.")

    // Ruling Q146 A: nothing resumes it until the person sends a message.
    expect(agents["claude-code"].resumeThread).not.toHaveBeenCalled()
    await ok("session.send", { sessionId: "session-restart", prompt: "go on" })
    expect(agents["claude-code"].resumeThread).toHaveBeenCalledOnce()
    const resumed = agents["claude-code"].resumeThread.mock.calls[0]![0]
    expect(resumed.threadId).toBe("claude-code-started")
    expect(resumed).not.toHaveProperty("repositoryTrust")
    expect(agents["claude-code"].startTurn.mock.calls[0]![0]).not.toHaveProperty("repositoryTrust")
    // The stopped thread is not stopped again on a second revoke.
    expect(await revoke()).toEqual([])
    expect(agents["claude-code"].stopThread).toHaveBeenCalledOnce()
  })

  it("interrupts an active turn before it stops the thread", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    expect((await sessionNamed("session-a")).activeTurnId).toBe("turn-thread-a")

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    const agent = agents["claude-code"]
    expect(agent.interruptTurn.mock.calls).toEqual([["thread-a", "turn-thread-a"]])
    expect(agent.stopThread.mock.calls).toEqual([["thread-a"]])
    expect(agent.interruptTurn.mock.invocationCallOrder[0]).toBeLessThan(agent.stopThread.mock.invocationCallOrder[0]!)
    const stopped = await sessionNamed("session-a")
    expect(stopped.state).toBe("idle")
    expect(stopped.activeTurnId).toBeUndefined()
    expect(stopped.providerThreadId).toBe("thread-a")
  })

  it("reports a stop that times out unconfirmed, and fails and fences the session", async () => {
    const { agents, grants, ok, rpc, revoke, sessionNamed, notices } = await fixture({ agentTimeoutMs: 300 })
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    agents["claude-code"].stopThread.mockImplementationOnce(() => new Promise<void>(() => {}))

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "unconfirmed" }])
    expect((await sessionNamed("session-a")).state).toBe("failed")
    expect(await notices("session-a")).toContain("Repository trust was taken back, and Domovoi could not confirm that the agent stopped.")
    // Fenced: no second agent starts in the same worktree until it is recovered.
    const refused = await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "again" })
    expect(refused).toMatchObject({ error: { message: "Provider thread requires recovery after emergency stop" } })
    expect(agents["claude-code"].resumeThread).toHaveBeenCalledOnce()
  })

  it("reports a stop that fails unconfirmed", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-b", prompt: "work" })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await revoke()).toEqual([{ sessionId: "session-b", outcome: "unconfirmed" }])
    expect((await sessionNamed("session-b")).state).toBe("failed")
  })

  // Ruling Q152 A: Codex runs every thread in one app-server and cannot
  // confirm that the tool servers a thread started have exited.
  it("reports a Codex thread unconfirmed even when its stop resolved", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-codex", prompt: "work" })
    expect(await revoke()).toEqual([{ sessionId: "session-codex", outcome: "unconfirmed" }])
    expect(agents.codex.stopThread.mock.calls).toEqual([["thread-codex"]])
    expect((await sessionNamed("session-codex")).state).toBe("failed")
  })

  it("leaves a thread that opened without the grant alone", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture()
    await ok("session.send", { sessionId: "session-a", prompt: "untrusted" })
    grants.set(projectId, grant(projectId))
    expect(await revoke()).toEqual([])
    expect(agents["claude-code"].interruptTurn).not.toHaveBeenCalled()
    expect(agents["claude-code"].stopThread).not.toHaveBeenCalled()
    expect((await sessionNamed("session-a")).activeTurnId).toBe("turn-thread-a")
  })

  // Ruling Q170 A: only a thread whose adapter reports that it loaded trusted
  // configuration is stopped. A grant that was passed and not applied leaves
  // the thread running, whatever the provider.
  it("leaves threads alone whose adapter does not report applied trust", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture({ reportsTrust: false })
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "claude" })
    await ok("session.send", { sessionId: "session-codex", prompt: "codex" })
    expect(trustOf(agents["claude-code"].startTurn.mock.calls[0]![0])).toEqual(grant(projectId))
    expect(trustOf(agents.codex.startTurn.mock.calls[0]![0])).toEqual(grant(projectId))

    expect(await revoke()).toEqual([])
    for (const agent of [agents["claude-code"], agents.codex]) {
      expect(agent.interruptTurn).not.toHaveBeenCalled()
      expect(agent.stopThread).not.toHaveBeenCalled()
    }
    expect(await sessionNamed("session-a")).toMatchObject({ state: "active", activeTurnId: "turn-thread-a" })
    expect(await sessionNamed("session-codex")).toMatchObject({ state: "active", activeTurnId: "turn-thread-codex" })
  })

  // A workspace holds the open project's sessions only, and opening another
  // project stops every thread; the grant of the project left behind, and the
  // thread it opened, are not the new project's to take back.
  it("leaves another project's grant and threads alone", async () => {
    const { agents, grants, ok, rpc, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "here" })
    const asked = await rpc("project.open", { client: "desktop", path: "/code/other" })
    const confirmation = (asked as { error: { data: unknown } }).error.data
    await ok("project.open", { path: "/code/other", confirmation })
    // Opening another project stopped acme's threads, thread-a among them.
    const switched = agents["claude-code"].stopThread.mock.calls.length
    expect(agents["claude-code"].stopThread).toHaveBeenCalledWith("thread-a")

    const other = `project-${createHash("sha256").update("/code/other").digest("hex").slice(0, 12)}`
    grants.set(other, grant(other))
    const created = workspaceSnapshotSchema.parse((await ok("session.create", { title: "other", runtime: claude })).result)
    const otherSession = created.sessions[0]!.id
    expect(await revoke(other)).toEqual([{ sessionId: otherSession, outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls.slice(switched)).toEqual([["claude-code-started"]])
    expect(grants.has(projectId)).toBe(true)
  })

  it("stops a thread whose resume was in flight when the revoke arrived, once it lands", async () => {
    const { agents, grants, rpc, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    const resume = deferred()
    agents["claude-code"].resumeThread.mockImplementationOnce(() => resume.promise)
    const sending = rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "work" })
    await waitForDaemon(() =>expect(agents["claude-code"].resumeThread).toHaveBeenCalledOnce())
    let revoked: Record<string, unknown> | undefined
    const revoking = rpc("repository.revokeTrust", { client: "desktop", projectId }).then((reply) => { revoked = reply })
    await settle()
    expect(revoked).toBeUndefined()
    expect(agents["claude-code"].stopThread).not.toHaveBeenCalled()

    resume.resolve()
    expect(await sending).toHaveProperty("result")
    await revoking
    expect(revoked).toMatchObject({ result: { threads: [{ sessionId: "session-a", outcome: "restarted" }] } })
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])
    expect((await sessionNamed("session-a")).activeTurnId).toBeUndefined()
  })
})

describe("repository.revokeTrust and an emergency stop", () => {
  it("takes the grant back at once during a stop, then stops what the stop left, once", async () => {
    const { agents, grants, ok, rpc, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    const interrupt = deferred()
    agents["claude-code"].interruptTurn.mockImplementationOnce(() => interrupt.promise)
    const stopping = rpc("system.emergencyStop", { client: "desktop" })
    await waitForDaemon(() =>expect(agents["claude-code"].interruptTurn).toHaveBeenCalledOnce())

    const revoking = rpc("repository.revokeTrust", { client: "desktop", projectId })
    await waitForDaemon(() =>expect(grants.has(projectId)).toBe(false))
    expect(agents["claude-code"].stopThread).not.toHaveBeenCalled()

    interrupt.resolve()
    expect(await stopping).toHaveProperty("result")
    expect(await revoking).toMatchObject({ result: { threads: [{ sessionId: "session-a", outcome: "restarted" }] } })
    // The stop interrupted the turn; the revoke only stopped the thread.
    expect(agents["claude-code"].interruptTurn).toHaveBeenCalledOnce()
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])

    await ok("session.send", { sessionId: "session-a", prompt: "go on" })
    expect(agents["claude-code"].resumeThread).toHaveBeenCalledTimes(2)
    expect(agents["claude-code"].resumeThread.mock.calls[1]![0]).not.toHaveProperty("repositoryTrust")
    expect((await sessionNamed("session-a")).state).toBe("active")
  })

  it("finishes a revoke that a stop overtakes, and the stop leaves its thread to it", async () => {
    const { agents, grants, ok, rpc, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    const interrupt = deferred()
    agents["claude-code"].interruptTurn.mockImplementationOnce(() => interrupt.promise)
    const revoking = rpc("repository.revokeTrust", { client: "desktop", projectId })
    await waitForDaemon(() =>expect(agents["claude-code"].interruptTurn).toHaveBeenCalledOnce())

    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped).toMatchObject({ result: { outcomes: { turnsStopped: 0, providersReset: 0 } } })

    interrupt.resolve()
    expect(await revoking).toMatchObject({ result: { threads: [{ sessionId: "session-a", outcome: "restarted" }] } })
    expect(agents["claude-code"].interruptTurn).toHaveBeenCalledOnce()
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])

    await ok("session.send", { sessionId: "session-a", prompt: "go on" })
    expect(agents["claude-code"].resumeThread).toHaveBeenCalledTimes(2)
    expect(agents["claude-code"].resumeThread.mock.calls[1]![0]).not.toHaveProperty("repositoryTrust")
    expect((await sessionNamed("session-a")).state).toBe("active")
  })
})
