import { once } from "node:events"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  type Runtime,
  type SessionHistoryEntry,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { SessionCommitRefusedError, type SessionCommit, type SessionCommitRequest, type WorkspaceService } from "./workspace.js"

// Walk finding F10 (ruled 2026-10-18): Domovoi commits a session's work on
// the person's word, because the agent's sandbox stays closed to .git. The
// commit follows the permission model: a person's control action, refused in
// Ask and Plan (both read-only) and while a turn runs; Auto changes nothing.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const projectId = "project-acme"
const head = "a".repeat(40)
const made = "c".repeat(40)
const build: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }

function agent() {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "claude-thread"),
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

async function fixture(options: {
  runtime?: Runtime
  changedFiles?: string[]
  refusal?: Error
  afterCommitError?: string
  // How long the workspace takes, and the daemon's deadline for it.
  delayMs?: number
  agentTimeoutMs?: number
} = {}) {
  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: "/code/acme", branch: "main" },
    sessions: [{
      id: "session-1", projectId, title: "Retry the webhook", state: "idle", runtime: options.runtime ?? build,
      changedFiles: 2, testsPassed: 0, testsFailed: 0, updatedAt: "2026-10-18T12:00:00.000Z",
      workspacePath: "/worktrees/session-1", providerThreadId: "thread-1",
    }],
  }
  const changedFiles = options.changedFiles ?? ["src/webhook.ts", "src/webhook.test.ts"]
  const commit = vi.fn(async (_path: string, request: SessionCommitRequest): Promise<SessionCommit> => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    if (options.refusal) throw options.refusal
    return {
      commit: made, branch: `domovoi/${request.sessionId}`, changedFiles,
      ...(options.afterCommitError ? { afterCommitError: options.afterCommitError } : {}),
    }
  })
  const workspaceService = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "acme", branch: "main", head })),
    createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({ path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: head })),
    removeSessionWorkspace: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    restore: vi.fn(),
    commit,
  } satisfies WorkspaceService
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({
    port: 0, statePath: ":memory:", store, agents: { "claude-code": agent() }, workspaceService, errorSink: vi.fn(),
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
  const commitRequest = (message = "fix(api): retry the webhook\n\nThe provider retries on 5xx.") =>
    rpc("session.commit", { sessionId: "session-1", message, expectedHead: head, client: "desktop" })
  const thread = async () => ((await rpc("workspace.get", {})).result as WorkspaceSnapshot).thread
  return { commit, commitRequest, rpc, thread }
}

type Refusal = { error: { code: number; message: string } }

describe("session.commit", () => {
  it("commits on the session branch and shows the message, the files and the sha in the thread", async () => {
    const { commit, commitRequest, rpc } = await fixture()

    const response = await commitRequest()

    expect(response).toHaveProperty("result")
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0]).toBe("/worktrees/session-1")
    expect(commit.mock.calls[0]![1]).toEqual({
      repositoryPath: "/code/acme",
      sessionId: "session-1", message: "fix(api): retry the webhook\n\nThe provider retries on 5xx.", expectedHead: head,
    })
    const snapshot = (response as { result: WorkspaceSnapshot }).result
    const item = snapshot.thread.at(-1)
    expect(item).toMatchObject({
      sessionId: "session-1",
      kind: "checkpoint",
      reason: "commit",
      label: "cccccccc · fix(api): retry the webhook",
      commit: made,
      committed: {
        message: "fix(api): retry the webhook\n\nThe provider retries on 5xx.",
        branch: "domovoi/session-1",
        paths: ["src/webhook.ts", "src/webhook.test.ts"],
        pathCount: 2,
        client: "desktop",
      },
    })
    const history = await rpc("session.history", { sessionId: "session-1", categories: ["checkpoints"] })
    const entries = (history as { result: { items: SessionHistoryEntry[] } }).result.items
    expect(entries.find((entry) => entry.category === "checkpoints" && entry.reason === "commit")).toMatchObject({ category: "checkpoints", reason: "commit", commit: made, committed: { pathCount: 2 } })
  })

  it("lists the first 50 files and counts them all", async () => {
    const changedFiles = Array.from({ length: 120 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`)
    const { commitRequest } = await fixture({ changedFiles })

    const snapshot = ((await commitRequest()) as { result: WorkspaceSnapshot }).result

    expect(snapshot.thread.at(-1)).toMatchObject({ committed: { paths: changedFiles.slice(0, 50), pathCount: 120 } })
  })

  it("commits in Build with Auto on: the commit is always the person's own action", async () => {
    const { commit, commitRequest } = await fixture({ runtime: { ...build, auto: true } })

    expect(await commitRequest()).toHaveProperty("result")
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it.each(["ask", "plan"] as const)("refuses in %s mode, which is read-only, and commits nothing", async (permissionMode) => {
    const { commit, commitRequest, thread } = await fixture({ runtime: { ...build, permissionMode } })
    const before = await thread()

    const response = await commitRequest() as Refusal

    expect(response.error.message).toMatch(/read-only/u)
    expect(response.error.message).toContain("Build")
    expect(commit).not.toHaveBeenCalled()
    expect(await thread()).toEqual(before)
  })

  it("refuses while a turn runs, so the branch never moves under a working agent", async () => {
    const { commit, commitRequest, rpc } = await fixture()
    expect(await rpc("session.send", { sessionId: "session-1", prompt: "Retry the webhook", client: "desktop" })).toHaveProperty("result")
    const running = ((await rpc("workspace.get", {})).result as WorkspaceSnapshot).sessions[0]!
    expect(running.activeTurnId).toBeDefined()

    const response = await commitRequest() as Refusal

    expect(response.error.message).toContain("turn")
    expect(commit).not.toHaveBeenCalled()
  })

  it("records a commit whose bookkeeping failed afterwards, and says what was left undone", async () => {
    const { commitRequest } = await fixture({ afterCommitError: "could not update the worktree's index" })

    const snapshot = ((await commitRequest()) as { result: WorkspaceSnapshot }).result

    const commitItem = snapshot.thread.findLast((item) => item.kind === "checkpoint")
    expect(commitItem).toMatchObject({ reason: "commit", commit: made })
    expect(snapshot.thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Committed cccccccc, with something left undone",
      detail: "could not update the worktree's index",
    })
  })

  it("records a commit that lands after the daemon's deadline", async () => {
    const { commitRequest, thread } = await fixture({ delayMs: 300, agentTimeoutMs: 50 })

    const response = await commitRequest() as Refusal

    expect(response.error.message).toBe("Commit timed out")
    await vi.waitFor(async () => {
      expect((await thread()).at(-1)).toMatchObject({ kind: "checkpoint", reason: "commit", commit: made })
    }, { timeout: 2_000 })
  })

  it("says why the worktree refused and records nothing", async () => {
    const { commitRequest, thread } = await fixture({ refusal: new SessionCommitRefusedError("secret-paths", "domovoi/session-1", 2) })
    const before = await thread()

    const response = await commitRequest() as Refusal

    expect(response.error.message).toContain("2 files in these changes look like a credential")
    expect(await thread()).toEqual(before)
  })
})
