import { once } from "node:events"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  approvalCheckpointErrorCode, approvalCheckpointRefusalSchema, demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import { GitNotFoundError } from "./git-command.js"
import { GitTooOldForIsolationError } from "./isolated-checkout.js"
import { RepositoryGitConfigUnreadableError } from "./repository-git-filters.js"
import { RepositoryConfigRefusedError, SubmoduleChangesRefusedError } from "./workspace.js"
import type { WorkspaceService } from "./workspace.js"

// J34, ruled 2026-09-23: when a person allows a gated command, the daemon
// takes a checkpoint first and names it on the receipt; if it cannot, the
// command does not run and the gate stays. The receipt says how long the
// command ran once its item completes, and says nothing when it never does.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const checkpointCommit = "c".repeat(40)

function pendingApproval(worktree: boolean | string = true): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "idle"
  if (worktree) session.workspacePath = typeof worktree === "string" ? worktree : "/worktrees/session-billing"
  else delete session.workspacePath
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  // Every gate here is raised after start: a stored one expires when the
  // daemon starts.
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

async function start(options: {
  worktree?: boolean | string
  checkpoint?: (worktree: string, label: string, signal?: AbortSignal) => Promise<{ commit: string, changedFiles: string[] }>
  agentTimeoutMs?: number
} = {}) {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn<() => Promise<string>>().mockResolvedValueOnce("turn-billing").mockResolvedValue("turn-billing-2"), steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(),
    snapshot: vi.fn(options.checkpoint ?? (async () => ({ commit: checkpointCommit, changedFiles: ["db/schema.sql"] }))),
  } satisfies WorkspaceService
  const daemon = new DomovoiDaemon({
    port: 0, store: new SqliteWorkspaceStore(":memory:", pendingApproval(options.worktree ?? true)),
    agents: { codex: provider }, workspaceService, errorSink: vi.fn(),
    ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message as Record<string, unknown>)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<{ result?: unknown, error?: { code: number, message: string, data?: unknown } }>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve as (message: Record<string, unknown>) => void)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await rpc("system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
  const snapshot = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  // A session without a worktree cannot start a turn, so its provider raises
  // the gate on the thread without one.
  if (options.worktree === false) {
    emit({ type: "approval-requested", requestId: 41, threadId: "thread-billing", itemId: "call_migrate", command: "pnpm migrate" })
    await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
    return { provider, workspaceService, rpc, snapshot, approvalId: (await snapshot()).approvals[0]!.id, emit: (event: AgentEvent) => emit(event) }
  }
  // The gate arrives the way a provider raises it: inside a running turn,
  // naming the item the command belongs to.
  const sent = await rpc("session.send", { sessionId: "session-billing", prompt: "run the migrations", client: "phone" }); expect(sent.error?.message).toBeUndefined()
  emit({ type: "approval-requested", requestId: 41, threadId: "thread-billing", turnId: "turn-billing", itemId: "call_migrate", command: "pnpm migrate" })
  await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
  const approvalId = (await snapshot()).approvals[0]!.id
  return { provider, workspaceService, rpc, snapshot, approvalId, emit: (event: AgentEvent) => emit(event) }
}

const allow = (approvalId: string, decision = "allow-once") => ({ approvalId, decision, revision: 0, client: "phone" })

describe("a checkpoint before an approved write", () => {
  it("is taken before the agent hears the decision, and named on the receipt", async () => {
    const { provider, workspaceService, rpc, snapshot, approvalId } = await start()
    expect((await rpc("approval.resolve", allow(approvalId))).error).toBeUndefined()
    expect(workspaceService.snapshot).toHaveBeenCalledOnce()
    expect(workspaceService.checkpoint).not.toHaveBeenCalled()
    expect(workspaceService.snapshot).toHaveBeenCalledWith("/worktrees/session-billing", "before approved command", expect.any(AbortSignal))
    expect(workspaceService.snapshot.mock.invocationCallOrder[0]!).toBeLessThan(provider.resolveApproval.mock.invocationCallOrder[0]!)
    const state = await snapshot()
    expect(state.thread).toContainEqual(expect.objectContaining({ kind: "checkpoint", reason: "before-approved-command", label: `${checkpointCommit.slice(0, 8)} · before an approved command`, commit: checkpointCommit, sessionId: "session-billing" }))
    expect(state.thread).toContainEqual(expect.objectContaining({ kind: "receipt", decision: "allow-once", checkpoint: checkpointCommit }))
  })

  it("keeps the gate when the checkpoint cannot be taken, and the command does not run", async () => {
    const { provider, rpc, snapshot, approvalId } = await start({ checkpoint: async () => { throw new Error("index.lock exists") } })
    const refused = await rpc("approval.resolve", allow(approvalId))
    expect(refused.error).toEqual({
      code: approvalCheckpointErrorCode,
      message: "Domovoi could not take a checkpoint, so the command did not run; decide again",
      data: { kind: "approval-checkpoint-refused", cause: "unknown" },
    })
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    const state = await snapshot()
    expect(state.approvals.map(({ id }) => id)).toEqual([approvalId])
    expect(state.thread.some((item) => item.kind === "receipt")).toBe(false)
    expect(state.thread.some((item) => item.kind === "checkpoint" && item.label.endsWith("before an approved command"))).toBe(false)
  })

  it("takes none for a denial, and says unavailable with no worktree", async () => {
    const denied = await start()
    expect((await denied.rpc("approval.resolve", allow(denied.approvalId, "deny"))).error).toBeUndefined()
    expect(denied.workspaceService.snapshot).not.toHaveBeenCalled()

    const bare = await start({ worktree: false })
    expect((await bare.rpc("approval.resolve", allow(bare.approvalId))).error).toBeUndefined()
    expect(bare.workspaceService.snapshot).not.toHaveBeenCalled()
    expect((await bare.snapshot()).thread).toContainEqual(expect.objectContaining({ kind: "receipt", checkpoint: "unavailable" }))
  })

  it("says how long the command ran once its item completes, and nothing before", async () => {
    const { rpc, snapshot, emit, approvalId } = await start()
    expect((await rpc("approval.resolve", allow(approvalId))).error).toBeUndefined()
    const receiptOf = async () => (await snapshot()).thread.find((item) => item.kind === "receipt")
    expect(await receiptOf()).not.toHaveProperty("ranForMs")
    emit({ type: "item", phase: "completed", params: { threadId: "thread-billing", turnId: "turn-billing", item: { id: "call_other", type: "commandExecution", status: "completed" } } })
    emit({ type: "item", phase: "completed", params: { threadId: "thread-billing", turnId: "turn-billing", item: { id: "call_migrate", type: "commandExecution", status: "completed", command: "pnpm migrate" } } })
    await waitForDaemon(async () => expect(await receiptOf()).toMatchObject({ ranForMs: expect.any(Number) }))
    expect(((await receiptOf()) as { ranForMs: number }).ranForMs).toBeGreaterThanOrEqual(0)
    const history = await rpc("session.history", { sessionId: "session-billing", categories: ["approvals"] })
    expect((history.result as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ ranForMs: expect.any(Number) })
  })

  it("leaves the run time out when the turn ends before the command's item completes", async () => {
    // Ruled 2026-09-23: ranForMs is absent when no completion arrives.
    const { rpc, snapshot, emit, approvalId } = await start()
    expect((await rpc("approval.resolve", allow(approvalId))).error).toBeUndefined()
    emit({ type: "turn-completed", params: { threadId: "thread-billing", turn: { id: "turn-billing", status: "interrupted" } } })
    await waitForDaemon(async () => expect((await snapshot()).sessions.find(({ id }) => id === "session-billing")).not.toHaveProperty("activeTurnId"))
    emit({ type: "item", phase: "completed", params: { threadId: "thread-billing", item: { id: "call_migrate", type: "commandExecution", status: "completed" } } })
    await rpc("workspace.get", {})
    expect((await snapshot()).thread.find((item) => item.kind === "receipt")).not.toHaveProperty("ranForMs")
  })

  it("never gives a run time to an old receipt when a later turn reuses the command's item id", async () => {
    // Review round 1 (P2): a pause ends the turn without a turn-completed event.
    const { rpc, snapshot, emit, approvalId } = await start()
    expect((await rpc("approval.resolve", allow(approvalId))).error).toBeUndefined()
    expect((await rpc("session.pause", { sessionId: "session-billing", client: "phone" })).error).toBeUndefined()
    await waitForDaemon(async () => expect((await snapshot()).sessions.find(({ id }) => id === "session-billing")).not.toHaveProperty("activeTurnId"))
    const sent = await rpc("session.send", { sessionId: "session-billing", prompt: "go on", client: "phone" })
    expect(sent.error?.message).toBeUndefined()
    await waitForDaemon(async () => expect((await snapshot()).sessions.find(({ id }) => id === "session-billing")?.activeTurnId).toBeDefined())
    emit({ type: "item", phase: "completed", params: { threadId: "thread-billing", turnId: "turn-billing-2", item: { id: "call_migrate", type: "commandExecution", status: "completed" } } })
    await rpc("workspace.get", {})
    expect((await snapshot()).thread.find((item) => item.kind === "receipt")).not.toHaveProperty("ranForMs")
  })

  it("says a submodule's local changes are why, and keeps the gate", async () => {
    const { provider, rpc, snapshot, approvalId } = await start({ checkpoint: async () => { throw new SubmoduleChangesRefusedError() } })
    const refused = await rpc("approval.resolve", allow(approvalId))
    expect(refused.error).toEqual({
      code: approvalCheckpointErrorCode,
      message: "Domovoi could not take a checkpoint: a submodule has local changes a checkpoint cannot hold, so the command did not run",
      data: { kind: "approval-checkpoint-refused", cause: "submodule-changes" },
    })
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    expect((await snapshot()).approvals.map(({ id }) => id)).toEqual([approvalId])
  })
})

// The refusal names its cause as data (S3.10h, #743): the card draws its line
// from the cause, never from the daemon's sentence.
describe("a typed checkpoint refusal", () => {
  const gitFailure = (stderr: string) => Object.assign(new Error(`Command failed: git update-ref\n${stderr}`), { code: 128, stderr })
  // A lock counts only when it is there, inside the worktree's own Git
  // directories, so the session's worktree here has a .git holding it.
  let worktree = ""
  let heldLock = ""
  let lockStderr = ""
  beforeAll(async () => {
    worktree = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-lock-")))
    await mkdir(join(worktree, ".git", "refs", "domovoi", "checkpoints"), { recursive: true })
    heldLock = join(worktree, ".git", "refs", "domovoi", "checkpoints", "cccc.lock")
    // The daemon names a lock only while it is there.
    await writeFile(heldLock, "")
    lockStderr = `fatal: cannot lock ref 'refs/domovoi/checkpoints/cccc': Unable to create '${heldLock}': File exists.\n\n`
      + "Another git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'."
  })
  afterAll(async () => {
    if (worktree) await rm(worktree, { recursive: true, force: true })
  })

  async function refusedWith(error: unknown) {
    const { provider, rpc, snapshot, approvalId } = await start({ worktree, checkpoint: async () => { throw error } })
    const refused = await rpc("approval.resolve", allow(approvalId))
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    expect((await snapshot()).approvals.map(({ id }) => id)).toEqual([approvalId])
    expect(refused.error?.code).toBe(approvalCheckpointErrorCode)
    expect(approvalCheckpointRefusalSchema.safeParse(refused.error?.data).success).toBe(true)
    return refused.error!
  }

  it("names a lock Git found held, by the path Git reported", async () => {
    expect(await refusedWith(gitFailure(lockStderr))).toEqual({
      code: approvalCheckpointErrorCode,
      message: `Domovoi could not take a checkpoint: ${heldLock} is held by another git process, or was left by one that stopped, so the command did not run; decide again`,
      data: { kind: "approval-checkpoint-refused", cause: "lock-held", lockPath: heldLock },
    })
  })

  it("finds the lock in a Git failure the workspace wrapped", async () => {
    const wrapped = new Error("Domovoi could not stage the checkpoint", { cause: gitFailure(lockStderr) })
    expect((await refusedWith(wrapped)).data).toEqual({ kind: "approval-checkpoint-refused", cause: "lock-held", lockPath: heldLock })
  })

  it("calls a lock path it cannot vouch for a Git failure", async () => {
    const relative = gitFailure("fatal: Unable to create '.git/index.lock': File exists.")
    const multiline = gitFailure("fatal: Unable to create '/repo/.git/\u0007index.lock': File exists.")
    for (const error of [relative, multiline]) {
      expect((await refusedWith(error)).data).toEqual({ kind: "approval-checkpoint-refused", cause: "git-failed" })
    }
  })

  it("says a Git command failed for any other Git error", async () => {
    expect(await refusedWith(gitFailure("fatal: unable to read tree 0123"))).toEqual({
      code: approvalCheckpointErrorCode,
      message: "Domovoi could not take a checkpoint because a Git command failed, so the command did not run; decide again",
      data: { kind: "approval-checkpoint-refused", cause: "git-failed" },
    })
  })

  it("names the repository's config, or says Git could not read it", async () => {
    const config = new RepositoryConfigRefusedError("The repository sets the filter \"lfs\" in its own Git config. Nothing ran.")
    expect(await refusedWith(config)).toEqual({
      code: approvalCheckpointErrorCode,
      message: "Domovoi could not take a checkpoint, so the command did not run; decide again. The repository sets the filter \"lfs\" in its own Git config. Nothing ran.",
      data: { kind: "approval-checkpoint-refused", cause: "repository-config" },
    })
    const unreadable = new RepositoryGitConfigUnreadableError("git-failed")
    expect(await refusedWith(unreadable)).toEqual({
      code: approvalCheckpointErrorCode,
      message: `Domovoi could not take a checkpoint, so the command did not run; decide again. ${unreadable.message}`,
      data: { kind: "approval-checkpoint-refused", cause: "repository-config-unreadable" },
    })
  })

  it("says Git is missing or too old", async () => {
    for (const error of [new GitNotFoundError("darwin"), new GitTooOldForIsolationError("2.20.0")]) {
      expect(await refusedWith(error)).toEqual({
        code: approvalCheckpointErrorCode,
        message: `Domovoi could not take a checkpoint, so the command did not run; decide again. ${error.message}`,
        data: { kind: "approval-checkpoint-refused", cause: "git-unavailable" },
      })
    }
  })

  it("says the checkpoint ran out of time", async () => {
    const { provider, rpc, snapshot, approvalId } = await start({
      agentTimeoutMs: 1_000,
      checkpoint: (_worktree, _label, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })
      }),
    })
    const refused = await rpc("approval.resolve", allow(approvalId))
    expect(refused.error).toEqual({
      code: approvalCheckpointErrorCode,
      message: "Domovoi could not take a checkpoint in time, so the command did not run; decide again",
      data: { kind: "approval-checkpoint-refused", cause: "timed-out" },
    })
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    expect((await snapshot()).approvals.map(({ id }) => id)).toEqual([approvalId])
  })
})
