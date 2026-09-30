import { once } from "node:events"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumRepositoryGitFilterDrivers,
  protocolVersion,
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { RepositoryGitFilter } from "./repository-git-filters.js"
import type { RepositoryProviderConfig, RepositoryProviderConfigOptions } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant, RepositoryTrustStore } from "./repository-trust-store.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { RepositoryGitFilterRefusedError, type WorkspaceService } from "./workspace.js"

// P8 slice A: a session.create or session.fork refused because checking the
// repository out would run a filter its own Git config sets answers with its
// own code, the drivers, and the repository's trust read now, so a client can
// offer the trust review (ruling Q3 A). Nothing ran and nothing of the new
// session is kept.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const projectId = "project-acme"
const projectPath = "/code/acme"
const claude: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
const digest = (digit: string) => `sha256:${digit.repeat(64)}`
// The new worktree and its branch are gone, or the worktree stayed.
const removed = { worktreeRemoved: true, branchRemoved: true }
const stayed = { worktreeRemoved: false, branchRemoved: undefined }
const grant = (digit: string): RepositoryTrustGrant => ({
  projectId, trustedDigest: digest(digit), trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" },
})
const filter = (driver: string, operation: RepositoryGitFilter["operation"] = "smudge"): RepositoryGitFilter => ({
  scope: "local", key: `filter.${driver}.${operation}`, driver, operation, value: `${driver} --decrypt`, origin: `${projectPath}/.git/config`,
})

function agent() {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{
      provider: claude.provider, id: claude.model, displayName: claude.model, description: "",
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high", isDefault: true,
    }]),
    startThread: vi.fn(async (_input: Parameters<AgentAdapter["startThread"]>[0]) => "claude-thread"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-1"),
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

async function fixture() {
  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: projectPath, branch: "main" },
    sessions: [{
      id: "session-source", projectId, title: "source", state: "idle", runtime: claude, changedFiles: 0, testsPassed: 0, testsFailed: 0,
      updatedAt: "2026-09-30T12:00:00.000Z", workspacePath: "/worktrees/session-source", providerThreadId: "thread-source",
    }],
  }
  snapshot.thread.push({
    id: "checkpoint-fork", sessionId: "session-source", kind: "checkpoint", label: "88888888 · fork point",
    commit: "8".repeat(40), createdAt: "2026-09-30T12:00:00.000Z",
  })
  const trust = { current: undefined as RepositoryTrustGrant | undefined }
  const repositoryTrust: RepositoryTrustStore = { find: () => trust.current, record: vi.fn(), revoke: vi.fn() }
  const config = { digest: digest("a"), fails: false }
  const repositoryProviderConfig = vi.fn(async (_root: string, _options: RepositoryProviderConfigOptions): Promise<RepositoryProviderConfig> => {
    if (config.fails) throw new Error("git config failed")
    return { configDigest: config.digest, providers: [], trustRefusals: [], documents: {} }
  })
  const workspaceService = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "acme", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40) })),
    createSessionWorkspaceFromCheckpoint: vi.fn(async (_path: string, commit: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: commit })),
    removeSessionWorkspace: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    restore: vi.fn(),
  } satisfies WorkspaceService
  const agents = { "claude-code": agent() }
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({
    port: 0, statePath: ":memory:", store, agents, workspaceService, repositoryTrust, repositoryProviderConfig, errorSink: vi.fn(),
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
  const create = () => rpc("session.create", { client: "desktop", title: "new", runtime: claude })
  const fork = () => rpc("session.fork", {
    client: "desktop", sessionId: "session-source", checkpointId: "checkpoint-fork", requestId: "fork-refused", runtime: claude,
  })
  const sessionIds = async () => ((await rpc("workspace.get", {})).result as WorkspaceSnapshot).sessions.map(({ id }) => id)
  return { agents, trust, config, repositoryProviderConfig, workspaceService, store, create, fork, sessionIds }
}

type Refusal = { error: { code: number; message: string; data?: unknown } }

describe("a session refused over a repository git filter", () => {
  it("answers session.create with the git filter code, the drivers and the trust read now, and keeps nothing", async () => {
    const { agents, repositoryProviderConfig, workspaceService, store, create, sessionIds } = await fixture()
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(
      new RepositoryGitFilterRefusedError([filter("sops"), filter("sops", "clean")], removed),
    )

    const reply = await create() as Refusal

    expect(reply.error.code).toBe(repositoryGitFilterErrorCode)
    expect(reply.error.message).toContain("filter.sops.smudge in local Git config")
    expect(reply.error.data).toEqual({
      kind: "repository-git-filter",
      projectId,
      configDigest: digest("a"),
      trust: { state: "untrusted", reason: "not-trusted" },
      drivers: [{ name: "sops", scope: "local" }],
      omittedDrivers: 0,
    })
    expect(repositoryGitFilterRefusalSchema.safeParse(reply.error.data).success).toBe(true)
    // The root as its sessions read it, with the refused checkout's filters.
    expect(repositoryProviderConfig).toHaveBeenCalledWith(projectPath, { ...projectRootRead, gitFilters: [filter("sops"), filter("sops", "clean")] })
    expect(agents["claude-code"].startThread).not.toHaveBeenCalled()
    expect(await sessionIds()).toEqual(["session-source"])
    expect(store.sessionCreations?.pending(projectId)).toEqual([])
  })

  it("reports a grant for an earlier digest as changed since it was trusted", async () => {
    const { trust, workspaceService, create } = await fixture()
    trust.current = grant("b")
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(new RepositoryGitFilterRefusedError([filter("sops")], removed))

    const reply = await create() as Refusal

    expect(reply.error.data).toMatchObject({
      configDigest: digest("a"),
      trust: { state: "untrusted", reason: "config-changed", trustedDigest: digest("b") },
    })
  })

  // Nothing runs a repository filter under trust in this slice: a grant for
  // the current digest reads as trusted, and the filter is held back all the same.
  it("still refuses under a grant for the current digest, and says it is trusted", async () => {
    const { trust, workspaceService, create } = await fixture()
    trust.current = grant("a")
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(new RepositoryGitFilterRefusedError([filter("sops")], removed))

    const reply = await create() as Refusal

    expect(reply.error.code).toBe(repositoryGitFilterErrorCode)
    expect(reply.error.data).toMatchObject({ trust: { state: "trusted", trustedDigest: digest("a") } })
  })

  it("answers session.fork the same way", async () => {
    const { agents, workspaceService, store, fork, sessionIds } = await fixture()
    workspaceService.createSessionWorkspaceFromCheckpoint.mockRejectedValueOnce(
      new RepositoryGitFilterRefusedError([{ ...filter("crypt"), scope: "worktree" }], removed),
    )

    const reply = await fork() as Refusal

    expect(reply.error.code).toBe(repositoryGitFilterErrorCode)
    expect(reply.error.data).toMatchObject({ projectId, drivers: [{ name: "crypt", scope: "worktree" }] })
    expect(agents["claude-code"].startThread).not.toHaveBeenCalled()
    expect(await sessionIds()).toEqual(["session-source"])
    expect(store.sessionCreations?.pending(projectId)).toEqual([])
  })

  it("names at most the protocol's cap of drivers and counts the rest", async () => {
    const { workspaceService, create } = await fixture()
    const many = Array.from({ length: maximumRepositoryGitFilterDrivers + 3 }, (_, index) => filter(`driver-${index}`))
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(new RepositoryGitFilterRefusedError(many, removed))

    const reply = await create() as Refusal

    const data = repositoryGitFilterRefusalSchema.parse(reply.error.data)
    expect(data.drivers).toHaveLength(maximumRepositoryGitFilterDrivers)
    expect(data.omittedDrivers).toBe(3)
  })

  it("keeps the refusal, without data, when the trust read fails", async () => {
    const { config, workspaceService, create } = await fixture()
    config.fails = true
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(new RepositoryGitFilterRefusedError([filter("sops")], removed))

    const reply = await create() as Refusal

    expect(reply.error.code).toBe(-32602)
    expect(reply.error.message).toContain("filter.sops.smudge in local Git config")
    expect(reply.error).not.toHaveProperty("data")
  })

  it("keeps its record of the attempt when the new worktree could not be taken away", async () => {
    const { workspaceService, store, create } = await fixture()
    workspaceService.createSessionWorkspace.mockRejectedValueOnce(new RepositoryGitFilterRefusedError([filter("sops")], stayed))

    const reply = await create() as Refusal

    expect(reply.error.code).toBe(repositoryGitFilterErrorCode)
    expect(store.sessionCreations?.pending(projectId)).toHaveLength(1)
  })
})
