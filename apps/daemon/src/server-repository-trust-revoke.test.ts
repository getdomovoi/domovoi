import { createHash } from "node:crypto"
import { once } from "node:events"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumRepositoryTrustThreadRestarts,
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

// A revoke result lists at most the protocol's cap of 1,024 threads; this
// file lowers the daemon's report cap to 3 so one test can pass it with four
// threads. That test checks the real value against the protocol.
vi.mock("./repository-trust-apply.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./repository-trust-apply.js")>(),
  maximumRevokedTrustThreads: 3,
}))

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
    // Test-only: what the provider tells the daemon.
    emit: (event: AgentEvent) => {
      for (const listener of listeners) listener(event)
    },
  } satisfies AgentAdapter & { emit: (event: AgentEvent) => void }
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
  snapshot.thread.push({
    id: "checkpoint-fork", sessionId: "session-a", kind: "checkpoint", label: "88888888 · fork point",
    commit: "8".repeat(40), createdAt: "2026-09-29T12:00:00.000Z",
  })
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
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({
    port: 0,
    statePath: ":memory:",
    store,
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
  return { agents, grants, rpc, ok, revoke, sessionNamed, notices, errorSink, store, workspaceService }
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
    // Fenced: no second agent starts in the same worktree while its stop
    // stays unconfirmed. The send tries the stop again first, and it fails.
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
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

  // Ruling Q179 A: the number of threads never stops a revoke, since refusing
  // would leave the grant in place. Every thread stops; the result lists up
  // to the report cap and counts the rest. This file lowers the cap to 3
  // (vi.mock above); the real one is the protocol's.
  it("deletes the grant and stops every thread past the report cap, counting the ones it does not list", async () => {
    const actual = await vi.importActual<typeof import("./repository-trust-apply.js")>("./repository-trust-apply.js")
    expect(actual.maximumRevokedTrustThreads).toBe(maximumRepositoryTrustThreadRestarts)

    const { agents, grants, ok, rpc } = await fixture()
    grants.set(projectId, grant(projectId))
    for (const sessionId of ["session-a", "session-b", "session-codex"]) await ok("session.send", { sessionId, prompt: "work" })
    await ok("session.restartProviderThread", { sessionId: "session-restart" })

    const reply = await rpc("repository.revokeTrust", { client: "desktop", projectId })
    const result = (reply as { result: { threads: { sessionId: string }[]; omittedThreads?: number } }).result
    expect(result.threads).toHaveLength(3)
    expect(result.omittedThreads).toBe(1)
    expect(grants.has(projectId)).toBe(false)
    expect(agents["claude-code"].stopThread.mock.calls.map(([threadId]) => threadId).sort())
      .toEqual(["claude-code-started", "thread-a", "thread-b"])
    expect(agents.codex.stopThread.mock.calls).toEqual([["thread-codex"]])
    // A result within the cap carries no count. The Codex thread was
    // unconfirmed, so it stays tracked and the next revoke tries it again.
    expect((await ok("repository.revokeTrust", { projectId })).result).toEqual({
      repository: expect.anything(), threads: [{ sessionId: "session-codex", outcome: "unconfirmed" }],
    })
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

// Security review round 1 of #669: a thread that loaded trusted input stays
// tracked until its exit is confirmed, whatever fails around it, and every
// revoke tries to stop it.
describe("repository.revokeTrust when bookkeeping or cleanup fails", () => {
  it("stops the thread when holding a queued send fails, and keeps an unconfirmed one for the next revoke", async () => {
    const { agents, grants, ok, revoke, store, errorSink } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    await ok("session.send", { sessionId: "session-a", prompt: "queued", delivery: "next-turn-replace" })
    vi.spyOn(store, "transitionQueuedSessionSend").mockImplementation(() => {
      throw new Error("disk I/O error")
    })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "unconfirmed" }])
    expect(agents["claude-code"].interruptTurn.mock.calls).toEqual([["thread-a", "turn-thread-a"]])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Domovoi could not record every change for a thread whose repository trust was taken back",
    }))
    // Still tracked: the next revoke tries the stop again.
    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"], ["thread-a"]])
  })

  it("stops, at the next revoke, a fork thread whose save and cleanup both failed", async () => {
    const { agents, grants, rpc, revoke, store } = await fixture()
    grants.set(projectId, grant(projectId))
    const save = store.saveAsync.bind(store)
    let failed = false
    vi.spyOn(store, "saveAsync").mockImplementation(async (snapshot) => {
      if (!failed && snapshot.sessions.length > 4) {
        failed = true
        throw new Error("disk full")
      }
      await save(snapshot)
    })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    const forked = await rpc("session.fork", {
      client: "desktop", sessionId: "session-a", checkpointId: "checkpoint-fork", requestId: "fork-save-fails", runtime: claude,
    })
    expect(forked).toHaveProperty("error")
    expect(failed).toBe(true)
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"]])

    expect(await revoke()).toEqual([{ sessionId: expect.any(String), outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"], ["claude-code-started"]])
  })

  it("bounds a hung handoff cleanup, so a revoke still runs and stops the thread", async () => {
    const { agents, grants, rpc, revoke, workspaceService } = await fixture({ agentTimeoutMs: 300 })
    grants.set(projectId, grant(projectId))
    workspaceService.checkpoint.mockRejectedValueOnce(new Error("checkpoint failed"))
    agents["claude-code"].stopThread.mockImplementationOnce(() => new Promise<void>(() => {}))
    const handoff = rpc("session.setRuntime", { client: "desktop", sessionId: "session-codex", runtime: claude })
    await waitForDaemon(() => expect(agents["claude-code"].stopThread).toHaveBeenCalledOnce())

    const revoking = revoke()
    const outcome = await Promise.race([revoking, new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000))])
    expect(outcome).toEqual([{ sessionId: "session-codex", outcome: "restarted" }])
    expect(await handoff).toHaveProperty("error")
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"], ["claude-code-started"]])
  })

  it("stops a tracked thread that quarantine took out of the loaded set without confirming its exit", async () => {
    const { agents, grants, rpc, revoke, sessionNamed } = await fixture({ agentTimeoutMs: 300 })
    grants.set(projectId, grant(projectId))
    agents["claude-code"].startTurn.mockImplementationOnce(() => new Promise<string>(() => {}))
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "work" })).toHaveProperty("error")
    expect((await sessionNamed("session-a")).providerThreadId).toBeUndefined()
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"], ["thread-a"]])
  })
})

// Security review round 2 of #669: a late start is tracked before its
// cleanup, a session is fenced while a thread that loaded trusted input may
// still run beside it, and a Codex stop never counts as a confirmed exit.
describe("threads whose exit is not confirmed", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  it("tracks a fork thread that started after its call timed out, so a revoke stops it when the late cleanup failed", async () => {
    const { agents, grants, rpc, revoke } = await fixture({ agentTimeoutMs: 300 })
    grants.set(projectId, grant(projectId))
    const start = agents["claude-code"].startThread.getMockImplementation()!
    agents["claude-code"].startThread.mockImplementationOnce(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      return start(input)
    })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    const forked = await rpc("session.fork", {
      client: "desktop", sessionId: "session-a", checkpointId: "checkpoint-fork", requestId: "fork-lands-late", runtime: claude,
    })
    expect(forked).toHaveProperty("error")
    await waitForDaemon(() => expect(agents["claude-code"].stopThread).toHaveBeenCalledOnce())

    expect(await revoke()).toEqual([{ sessionId: expect.any(String), outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"], ["claude-code-started"]])
  })

  it("refuses a message while a handoff thread whose cleanup failed may still run, until a revoke confirms its stop", async () => {
    const { agents, grants, ok, rpc, revoke, workspaceService } = await fixture()
    grants.set(projectId, grant(projectId))
    workspaceService.checkpoint.mockRejectedValueOnce(new Error("checkpoint failed"))
    let stops = false
    agents["claude-code"].stopThread.mockImplementation(async () => {
      if (!stops) throw new Error("provider gone")
    })
    expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-codex", runtime: claude })).toHaveProperty("error")

    expect(await rpc("session.send", { client: "desktop", sessionId: "session-codex", prompt: "go" }))
      .toMatchObject({ error: { message: fenced } })
    expect(agents.codex.startTurn).not.toHaveBeenCalled()

    stops = true
    expect(await revoke()).toEqual([{ sessionId: "session-codex", outcome: "restarted" }])
    await ok("session.send", { sessionId: "session-codex", prompt: "go" })
    expect(agents.codex.startTurn).toHaveBeenCalledOnce()
  })

  it("refuses another restart while a restarted thread whose cleanup failed may still run, until its stop is confirmed", async () => {
    const { agents, grants, ok, rpc, store } = await fixture()
    grants.set(projectId, grant(projectId))
    vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new Error("disk full")
    })
    let stops = false
    agents["claude-code"].stopThread.mockImplementation(async () => {
      if (!stops) throw new Error("provider gone")
    })
    expect(await rpc("session.restartProviderThread", { client: "desktop", sessionId: "session-restart" })).toHaveProperty("error")
    expect(agents["claude-code"].startThread).toHaveBeenCalledOnce()

    expect(await rpc("session.restartProviderThread", { client: "desktop", sessionId: "session-restart" }))
      .toMatchObject({ error: { message: fenced } })
    expect(agents["claude-code"].startThread).toHaveBeenCalledOnce()

    // The fence is tried again at the next attempt; a confirmed stop lifts it.
    stops = true
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    expect(agents["claude-code"].startThread).toHaveBeenCalledTimes(2)
  })

  it("remembers a Codex thread an archive stopped, and a later revoke reports it unconfirmed", async () => {
    const { agents, grants, ok, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.restartProviderThread", { sessionId: "session-restart", runtime: codex })
    await ok("session.archive", { sessionId: "session-restart" })
    expect(agents.codex.stopThread.mock.calls).toEqual([["codex-started"]])

    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "unconfirmed" }])
    expect(agents.codex.stopThread.mock.calls).toEqual([["codex-started"], ["codex-started"]])
  })
})

// Ruling Q186 A: tool servers a stopped Codex thread may have left run under
// consent while the grant holds. They fence nothing until trust is taken
// back; then each is reported unconfirmed and fences its session until the
// daemon restarts.
describe("a stopped Codex thread while the grant holds", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  it("leaves the session usable after an emergency stop resets it, and a later revoke fences it", async () => {
    const { agents, grants, ok, rpc, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-codex", prompt: "work" })
    // The interrupt fails, so the stop resets the provider thread instead.
    agents.codex.interruptTurn.mockRejectedValueOnce(new Error("interrupt refused"))
    expect(await rpc("system.emergencyStop", { client: "desktop" })).toHaveProperty("result")
    expect(agents.codex.stopThread.mock.calls).toEqual([["thread-codex"]])

    await ok("session.restartProviderThread", { sessionId: "session-codex", runtime: codex })
    await ok("session.send", { sessionId: "session-codex", prompt: "again" })
    expect(agents.codex.startTurn).toHaveBeenCalledTimes(2)

    expect(await revoke()).toEqual([{ sessionId: "session-codex", outcome: "unconfirmed" }])
    expect(agents.codex.stopThread.mock.calls.map(([threadId]) => threadId).sort())
      .toEqual(["codex-started", "thread-codex", "thread-codex"])
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-codex", prompt: "after" }))
      .toMatchObject({ error: { message: fenced } })
  })

  it("allows a handoff away from a trusted Codex thread, and a later revoke fences the session", async () => {
    const { agents, grants, ok, rpc, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.restartProviderThread", { sessionId: "session-restart", runtime: codex })
    await ok("session.setRuntime", { sessionId: "session-restart", runtime: claude })
    expect(agents.codex.stopThread.mock.calls).toEqual([["codex-started"]])
    await ok("session.send", { sessionId: "session-restart", prompt: "on claude" })

    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "unconfirmed" }])
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "after" }))
      .toMatchObject({ error: { message: fenced } })
    // A new grant does not lift it.
    grants.set(projectId, grant(projectId))
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "regranted" }))
      .toMatchObject({ error: { message: fenced } })
  })
})

// Security review round 3 of #669: a stop that finishes while a revoke is
// stopping the same Codex thread must not move it out of the revoke's hold.
describe("a revoke racing another stop of the same Codex thread", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  for (const first of ["cleanup", "revoke"] as const) {
    it(`fences the session when the ${first} stop finishes first`, async () => {
      const { agents, grants, rpc, revoke } = await fixture({ agentTimeoutMs: 1_000 })
      grants.set(projectId, grant(projectId))
      const landing = deferred()
      const start = agents.codex.startThread.getMockImplementation()!
      agents.codex.startThread.mockImplementationOnce(async (input) => {
        await landing.promise
        return start(input)
      })
      const cleanupStop = deferred()
      const revokeStop = deferred()
      agents.codex.stopThread
        .mockImplementationOnce(() => cleanupStop.promise)
        .mockImplementationOnce(() => revokeStop.promise)

      // The handoff to Codex times out; its thread lands late, loaded with
      // trusted configuration, and its cleanup stop waits.
      expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-a", runtime: codex })).toHaveProperty("error")
      landing.resolve()
      await waitForDaemon(() => expect(agents.codex.stopThread).toHaveBeenCalledOnce())
      const revoking = revoke()
      await waitForDaemon(() => expect(agents.codex.stopThread).toHaveBeenCalledTimes(2))
      const [earlier, later] = first === "cleanup" ? [cleanupStop, revokeStop] : [revokeStop, cleanupStop]
      earlier.resolve()
      await settle()
      later.resolve()
      expect(await revoking).toEqual([{ sessionId: "session-a", outcome: "unconfirmed" }])

      expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "after" }))
        .toMatchObject({ error: { message: fenced } })
      expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-a", runtime: codex }))
        .toMatchObject({ error: { message: fenced } })
      expect(await rpc("session.fork", {
        client: "desktop", sessionId: "session-a", checkpointId: "checkpoint-fork", requestId: `fork-after-${first}`, runtime: claude,
      })).toMatchObject({ error: { message: fenced } })
      // The session still names its own thread, so a restart is refused too.
      expect(await rpc("session.restartProviderThread", { client: "desktop", sessionId: "session-a" })).toHaveProperty("error")
      expect(agents["claude-code"].resumeThread).not.toHaveBeenCalled()
      expect(agents["claude-code"].startThread).not.toHaveBeenCalled()
      expect(agents.codex.startThread).toHaveBeenCalledOnce()
    })
  }
})

// Security review round 4 of #669: a revoke that confirms a stop an earlier
// stop could not lifts that thread's fence, and the session is usable again
// once no other thread holds it.
describe("a revoke that confirms a stop an earlier one could not", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  it("lets a message through once a later revoke confirms what an earlier one could not", async () => {
    const { agents, grants, ok, revoke, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "unconfirmed" }])
    expect((await sessionNamed("session-a")).state).toBe("failed")

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect((await sessionNamed("session-a")).state).toBe("idle")
    await ok("session.send", { sessionId: "session-a", prompt: "go on" })
    expect(agents["claude-code"].resumeThread.mock.calls.at(-1)![0]).toMatchObject({ threadId: "thread-a" })
  })

  it("lets a message through once a revoke confirms what a failed emergency stop could not", async () => {
    const { agents, grants, ok, rpc, revoke, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    agents["claude-code"].interruptTurn.mockRejectedValueOnce(new Error("interrupt refused"))
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await rpc("system.emergencyStop", { client: "desktop" })).toHaveProperty("result")
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "blocked" }))
      .toMatchObject({ error: { message: fenced } })

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect((await sessionNamed("session-a")).state).toBe("idle")
    await ok("session.send", { sessionId: "session-a", prompt: "go on" })
  })

  it("keeps refusing a session while another of its threads is still unconfirmed", async () => {
    const { agents, grants, ok, rpc, revoke, workspaceService } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    // A handoff to Codex fails and its thread cannot be stopped.
    workspaceService.checkpoint.mockRejectedValueOnce(new Error("checkpoint failed"))
    agents.codex.stopThread.mockRejectedValue(new Error("provider gone"))
    expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-restart", runtime: codex })).toHaveProperty("error")

    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "unconfirmed" }])
    // The Claude thread is confirmed now; the Codex one is not.
    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "unconfirmed" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["claude-code-started"], ["claude-code-started"]])
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "blocked" }))
      .toMatchObject({ error: { message: fenced } })
  })
})

// Security review round 5 of #669.
describe("fences a retry or a fork cannot lift", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  it("keeps fencing a session whose detached Codex thread failed its cleanup, after a retried stop resolves", async () => {
    const { agents, grants, ok, rpc, workspaceService } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    workspaceService.checkpoint.mockRejectedValueOnce(new Error("checkpoint failed"))
    agents.codex.stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-restart", runtime: codex })).toHaveProperty("error")

    // The retried Codex stop resolves, which never confirms its tool servers exited.
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "go" }))
      .toMatchObject({ error: { message: fenced } })
    expect(agents.codex.stopThread.mock.calls).toEqual([["codex-started"], ["codex-started"]])
    expect(agents["claude-code"].startTurn).not.toHaveBeenCalled()
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "again" }))
      .toMatchObject({ error: { message: fenced } })
  })

  it("refuses to fork a session whose own thread an emergency stop could not stop", async () => {
    const { agents, grants, ok, rpc } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    agents["claude-code"].interruptTurn.mockRejectedValueOnce(new Error("interrupt refused"))
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await rpc("system.emergencyStop", { client: "desktop" })).toHaveProperty("result")

    expect(await rpc("session.fork", {
      client: "desktop", sessionId: "session-a", checkpointId: "checkpoint-fork", requestId: "fork-after-failed-stop", runtime: claude,
    })).toMatchObject({ error: { message: fenced } })
    expect(agents["claude-code"].startThread).not.toHaveBeenCalled()
  })
})

// Security review round 6 of #669 (ruling Q188 A): recovery through a
// provider switch cannot confirm that a trusted Codex thread's tool servers
// exited, so it is refused; recovery of any thread whose stop confirms exit,
// or of an untrusted one, is unchanged.
describe("recovering a session whose own thread an emergency stop could not stop", () => {
  const fenced = "Provider thread requires recovery after emergency stop"

  const failEmergencyStop = async (
    agent: ReturnType<typeof agentFor>,
    rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => {
    agent.interruptTurn.mockRejectedValueOnce(new Error("interrupt refused"))
    agent.stopThread.mockRejectedValueOnce(new Error("provider gone"))
    expect(await rpc("system.emergencyStop", { client: "desktop" })).toHaveProperty("result")
  }

  it("refuses to recover a trusted Codex thread, keeping it tracked for a later revoke", async () => {
    const { agents, grants, ok, rpc, revoke } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-codex", prompt: "work" })
    await failEmergencyStop(agents.codex, rpc)

    expect(await rpc("session.setRuntime", { client: "desktop", sessionId: "session-codex", runtime: claude }))
      .toMatchObject({ error: { message: fenced } })
    expect(agents["claude-code"].startThread).not.toHaveBeenCalled()
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-codex", prompt: "again" }))
      .toMatchObject({ error: { message: fenced } })
    expect(await revoke()).toEqual([{ sessionId: "session-codex", outcome: "unconfirmed" }])
  })

  it("still recovers a trusted Claude thread through a provider switch", async () => {
    const { agents, grants, ok, rpc, sessionNamed } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    await failEmergencyStop(agents["claude-code"], rpc)

    await ok("session.setRuntime", { sessionId: "session-a", runtime: claude })
    expect(agents["claude-code"].startThread).toHaveBeenCalledOnce()
    expect(await sessionNamed("session-a")).toMatchObject({ state: "idle", providerThreadId: "claude-code-started" })
  })

  it("still recovers an untrusted Codex thread through a provider switch", async () => {
    const { agents, ok, rpc, sessionNamed } = await fixture()
    await ok("session.send", { sessionId: "session-codex", prompt: "work" })
    await failEmergencyStop(agents.codex, rpc)

    await ok("session.setRuntime", { sessionId: "session-codex", runtime: claude })
    expect(agents["claude-code"].startThread).toHaveBeenCalledOnce()
    expect(await sessionNamed("session-codex")).toMatchObject({ state: "idle", providerThreadId: "claude-code-started" })
  })
})

// GPT review of #669 (ruling Q198 A).
describe("grant-carrying calls that time out, and a revoke of a waiting session", () => {
  it("tracks a thread whose resume with the grant timed out, so a revoke stops it after the quarantine and late stops failed", async () => {
    const { agents, grants, rpc, revoke } = await fixture({ agentTimeoutMs: 300 })
    grants.set(projectId, grant(projectId))
    const resume = agents["claude-code"].resumeThread.getMockImplementation()!
    const landing = deferred()
    agents["claude-code"].resumeThread.mockImplementationOnce(async (input) => {
      await landing.promise
      return resume(input)
    })
    agents["claude-code"].stopThread.mockRejectedValue(new Error("provider gone"))
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "work" })).toHaveProperty("error")
    landing.resolve()
    await settle()

    agents["claude-code"].stopThread.mockResolvedValue(undefined)
    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls.at(-1)).toEqual(["thread-a"])
  })

  it("tracks a thread whose turn start with the grant timed out, so a revoke stops it after the quarantine and late stops failed", async () => {
    const { agents, grants, ok, rpc, revoke } = await fixture({ agentTimeoutMs: 300 })
    // Opened before the grant, so only the turn start carries it.
    await ok("session.restartProviderThread", { sessionId: "session-restart" })
    grants.set(projectId, grant(projectId))
    const startTurn = agents["claude-code"].startTurn.getMockImplementation()!
    const landing = deferred()
    agents["claude-code"].startTurn.mockImplementationOnce(async (input) => {
      await landing.promise
      return startTurn(input)
    })
    agents["claude-code"].stopThread.mockRejectedValue(new Error("provider gone"))
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-restart", prompt: "work" })).toHaveProperty("error")
    landing.resolve()
    await settle()

    agents["claude-code"].stopThread.mockResolvedValue(undefined)
    expect(await revoke()).toEqual([{ sessionId: "session-restart", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls.at(-1)).toEqual(["claude-code-started"])
  })

  it("leaves a session that waited on an approval idle, with the approval gone, and lets it fork", async () => {
    const { agents, grants, ok, revoke, sessionNamed, store } = await fixture()
    grants.set(projectId, grant(projectId))
    await ok("session.send", { sessionId: "session-a", prompt: "work" })
    agents["claude-code"].emit({
      type: "approval-requested", requestId: 7, threadId: "thread-a", turnId: "turn-thread-a", itemId: "call_ls", command: "ls",
    })
    await waitForDaemon(async () => expect((await sessionNamed("session-a")).state).toBe("waiting"))

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(await sessionNamed("session-a")).toMatchObject({ state: "idle" })
    expect(store.load().approvals).toEqual([])
    await ok("session.fork", { sessionId: "session-a", checkpointId: "checkpoint-fork", requestId: "fork-after-waiting", runtime: claude })
  })
})

// Security review round 8 of #669: a grant-carrying call that timed out
// holds its thread tracked until the call settles, whatever stops it meanwhile.
describe("a timed-out grant-carrying resume that has not settled", () => {
  const timedOutResume = async (settle: (applied: () => Promise<void>) => Promise<void>) => {
    const context = await fixture({ agentTimeoutMs: 300 })
    const { agents, grants, rpc } = context
    grants.set(projectId, grant(projectId))
    const resume = agents["claude-code"].resumeThread.getMockImplementation()!
    agents["claude-code"].resumeThread.mockImplementationOnce(async (input) => settle(() => resume(input)))
    // The quarantine's stop resolves while the resume is still out.
    expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "work" })).toHaveProperty("error")
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"]])
    return context
  }

  it("stops a thread whose resume applied the grant and then rejected, and a revoke still finds it when that stop fails", async () => {
    const landing = deferred()
    const { agents, revoke } = await timedOutResume(async (applied) => {
      await landing.promise
      await applied()
      throw new Error("resume failed after loading")
    })
    agents["claude-code"].stopThread.mockRejectedValueOnce(new Error("provider gone"))
    landing.resolve()
    await waitForDaemon(() => expect(agents["claude-code"].stopThread).toHaveBeenCalledTimes(2))

    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"], ["thread-a"], ["thread-a"]])
  })

  it("lets a revoke stop a thread whose resume applied the grant and is still out", async () => {
    const { agents, revoke } = await timedOutResume(async (applied) => {
      await applied()
      await new Promise<void>(() => {})
    })
    expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
    expect(agents["claude-code"].stopThread.mock.calls).toEqual([["thread-a"], ["thread-a"]])
  })

  it("stops a thread whose resume landed late, and forgets it once that stop is confirmed", async () => {
    const landing = deferred()
    const { agents, revoke } = await timedOutResume(async (applied) => {
      await landing.promise
      await applied()
    })
    landing.resolve()
    await waitForDaemon(() => expect(agents["claude-code"].stopThread).toHaveBeenCalledTimes(2))
    expect(await revoke()).toEqual([])
  })
})

// Security review round 9 of #669: tracking leaves only when no grant-carrying
// call or late stop on the thread is in flight and a stop that began after
// the last possible grant application confirmed its exit.
describe("a revoke held open while a timed-out resume applies the grant", () => {
  for (const lateStop of ["fails", "succeeds"] as const) {
    it(`keeps the thread tracked until a later stop confirms it, when the late stop ${lateStop}`, async () => {
      const { agents, grants, ok, rpc, revoke } = await fixture({ agentTimeoutMs: 1_000 })
      grants.set(projectId, grant(projectId))
      const agent = agents["claude-code"]
      await ok("session.send", { sessionId: "session-b", prompt: "work" })
      const resume = agent.resumeThread.getMockImplementation()!
      const landing = deferred()
      agent.resumeThread.mockImplementationOnce(async (input) => {
        await landing.promise
        await resume(input)
      })
      // The resume of thread-a times out and the quarantine stops it.
      expect(await rpc("session.send", { client: "desktop", sessionId: "session-a", prompt: "work" })).toHaveProperty("error")
      expect(agent.stopThread.mock.calls).toEqual([["thread-a"]])

      // The revoke stops thread-a at once; thread-b's interrupt holds it open.
      const holdB = deferred()
      agent.interruptTurn.mockImplementationOnce(() => holdB.promise)
      const revoking = revoke()
      await waitForDaemon(() => expect(agent.stopThread.mock.calls).toEqual([["thread-a"], ["thread-a"]]))

      // The resume then applies the grant and settles, and its late stop runs.
      if (lateStop === "fails") agent.stopThread.mockRejectedValueOnce(new Error("provider gone"))
      landing.resolve()
      await waitForDaemon(() => expect(agent.stopThread).toHaveBeenCalledTimes(3))
      holdB.resolve()
      const first = await revoking
      expect([...first].sort((a, b) => String((a as { sessionId: string }).sessionId).localeCompare(String((b as { sessionId: string }).sessionId))))
        .toEqual([{ sessionId: "session-a", outcome: "restarted" }, { sessionId: "session-b", outcome: "restarted" }])

      if (lateStop === "fails") {
        expect(await revoke()).toEqual([{ sessionId: "session-a", outcome: "restarted" }])
      } else {
        expect(await revoke()).toEqual([])
      }
    })
  }
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
