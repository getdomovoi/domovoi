import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, demoWorkspace, protocolVersion, type Runtime, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter, type ClaudeQueryFactory, type ClaudeQueryOptions } from "./claude.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import type { RepositoryTrustGrant, RepositoryTrustStore } from "./repository-trust-store.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { FakeClaudeQuery } from "./test-claude-process.js"
import { removeScratchDirectories } from "./test-scratch.js"
import type { WorkspaceService } from "./workspace.js"

// Slice P6b, from the daemon's side: a server a trusted repository brings
// starts with its Claude session, and a call to one of its tools is still a
// card that names the server and can never be answered Always (ruling Q5 A,
// #665). Trust loads the server; it answers no card.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories.splice(0))
})

const projectId = "project-acme"
const claude: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }

async function fixture() {
  const worktree = await mkdtemp(join(tmpdir(), "domovoi-claude-repository-server-"))
  scratchDirectories.push(worktree)
  await writeFile(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: { planted: { command: "planted-mcp" } } }))
  const { configDigest } = await readRepositoryProviderConfig(worktree, { heldBack: true })
  const grant: RepositoryTrustGrant = { projectId, trustedDigest: configDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" } }
  const repositoryTrust: RepositoryTrustStore = { find: () => grant, record: vi.fn(), revoke: vi.fn() }

  const calls: Array<{ options: ClaudeQueryOptions; query: FakeClaudeQuery }> = []
  const factory: ClaudeQueryFactory = (_input, options) => {
    const query = new FakeClaudeQuery(undefined)
    vi.spyOn(query, "setMcpServers")
    calls.push({ options, query })
    return query
  }
  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: worktree, branch: "main" },
    sessions: [{
      id: "session-trusted", projectId, title: "trusted", state: "idle", runtime: claude, changedFiles: 0, testsPassed: 0, testsFailed: 0,
      updatedAt: "2026-09-29T12:00:00.000Z", workspacePath: worktree, providerThreadId: "thread-trusted",
    }],
  }
  const workspaceService = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "acme", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40) })),
    createSessionWorkspaceFromCheckpoint: vi.fn(async (_path: string, commit: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: commit })),
    removeSessionWorkspace: vi.fn(async () => {}),
    archiveSessionWorkspace: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    // The checkpoint an approved call is taken with.
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
    restore: vi.fn(),
  } satisfies WorkspaceService
  const daemon = new DomovoiDaemon({
    port: 0, statePath: ":memory:", store: new SqliteWorkspaceStore(":memory:", snapshot),
    agents: { "claude-code": new ClaudeAgentSdkAdapter(factory) }, workspaceService, repositoryTrust, errorSink: vi.fn(),
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
  return { calls, rpc }
}

describe("a trusted repository's tool server", () => {
  it("starts with the Claude session, and a call to its tool is a card naming it that refuses Always", async () => {
    const { calls, rpc } = await fixture()
    expect(await rpc("session.send", { sessionId: "session-trusted", prompt: "Query the database", client: "desktop" })).not.toHaveProperty("error")

    const session = calls.find(({ options }) => options.resume === "thread-trusted")!
    expect(session.query.setMcpServers).toHaveBeenCalledWith({ planted: { command: "planted-mcp" } })

    // Claude asks before it calls the server's tool, as it asks for any tool
    // no rule allows.
    const decided = session.options.canUseTool!("mcp__planted__query", { sql: "select 1" }, {
      signal: new AbortController().signal, toolUseID: "tool-planted", requestId: "request-planted",
    })
    type Card = { id: string; toolServer?: unknown; execution: { state: string } }
    let card: Card | undefined
    await vi.waitFor(async () => {
      card = ((await rpc("workspace.get", {})).result as { approvals: Card[] }).approvals[0]
      expect(card).toBeDefined()
    }, { timeout: 3_000 })
    expect(card).toMatchObject({ toolServer: { name: "planted" }, execution: { state: "unresolved" } })
    expect(JSON.stringify(card)).toContain("mcp__planted__query")

    await expect(rpc("approval.resolve", { approvalId: card!.id, decision: "always-project", revision: 0, client: "desktop" }))
      .resolves.toMatchObject({ error: { message: "Tool server calls cannot create standing rules" } })
    const allowed = await rpc("approval.resolve", { approvalId: card!.id, decision: "allow-once", revision: 0, client: "desktop" })
    expect(allowed, JSON.stringify(allowed)).not.toHaveProperty("error")
    await expect(decided).resolves.toEqual({ behavior: "allow", updatedInput: { sql: "select 1" } })
    expect(((await rpc("workspace.get", {})).result as { approvalRules: unknown[] }).approvalRules).toHaveLength(0)
  })
})
