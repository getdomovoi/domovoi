import { once } from "node:events"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  daemonPersistenceUnavailableErrorCode,
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { ApprovalRequestNotPendingError, type AgentAdapter, type AgentEvent } from "./agents.js"
import type { AuditLog } from "./audit-log.js"
import { resolveCommandExecution } from "./execution-resolution.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

// Q243 A, 2026-10-01: an OpenCode or Kilo server's password is readable by
// any program the server starts. When the adapter sees an approval reply it
// did not send, it stops the thread and says so; the daemon then fails the
// session with its own failure, drops the session's cards, holds a queued
// send, records the stop in the audit log, and resumes the thread afresh
// only when the person sends again.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratch)
})

function scratchDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "domovoi-elsewhere-")))
  scratch.push(directory)
  return directory
}

const sessionId = "session-billing"
const threadId = "ses_billing"
const answeredElsewhere = {
  kind: "approval-answered-elsewhere",
  action: "review-changes",
  message: "An approval was answered outside Domovoi",
  retryable: false,
} as const
const notice = "An approval in this session was answered outside Domovoi, so Domovoi stopped the session."
const restarted = "Domovoi restarted the OpenCode server because an approval was answered outside Domovoi, so no approval it kept stays in place"

function openCodeSession(workspacePath: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "opencode", model: "anthropic/sonnet", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = workspacePath
  session.providerThreadId = threadId
  delete session.activeTurnId
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

function recordingAuditLog() {
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-elsewhere-${append.mock.calls.length}`,
    occurredAt: "2026-10-01T12:00:00.000Z",
    ...input,
  }))
  const auditLog = {
    append,
    query: vi.fn(() => ({ entries: [], hasMore: false })),
    export: vi.fn(() => ({
      format: "jsonl" as const,
      exportedAt: "2026-10-01T12:00:00.000Z",
      content: "",
      entryCount: 0,
      hasMore: false,
    })),
  } satisfies AuditLog
  return { append, auditLog }
}

// `storePath` puts the state in a SQLite file, so what reached disk can be
// read back through a second connection; otherwise it stays in memory.
async function start({ workspacePath = "/worktrees/session-billing", storePath = ":memory:" } = {}) {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{
      provider: "opencode", id: "anthropic/sonnet", displayName: "Anthropic / Claude Sonnet", description: "",
      supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high", isDefault: true,
    }]),
    startThread: vi.fn(async () => "ses_fresh"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn<() => Promise<string>>().mockResolvedValueOnce("turn-billing").mockResolvedValue("turn-billing-2"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(async () => ({ commit: "a".repeat(40), changedFiles: [] })),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
    archiveSessionWorkspace: vi.fn(async () => {}),
  } satisfies WorkspaceService
  const { append, auditLog } = recordingAuditLog()
  const store = new SqliteWorkspaceStore(storePath, openCodeSession(workspacePath))
  const daemon = new DomovoiDaemon({
    port: 0, store, auditLog,
    agents: { opencode: provider }, workspaceService, errorSink: vi.fn(),
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
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<{ result?: unknown, error?: { code: number, message: string } }>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve as (message: Record<string, unknown>) => void)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await rpc("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
  const snapshot = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  const session = async () => (await snapshot()).sessions.find(({ id }) => id === sessionId)!
  const sent = await rpc("session.send", { sessionId, prompt: "build it", client: "desktop" })
  expect(sent.error?.message).toBeUndefined()
  emit({ type: "approval-requested", requestId: 41, threadId, turnId: "turn-billing", itemId: "call_build", command: "pnpm build" })
  await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
  return { provider, workspaceService, store, rpc, snapshot, session, append, emit: (event: AgentEvent) => emit(event) }
}

// A worktree on disk, so a command card settles to a resolved record and an
// ordinary gate that can take a standing rule, and a state file beside it.
function onDisk(): { workspacePath: string; storePath: string } {
  return { workspacePath: scratchDirectory(), storePath: join(scratchDirectory(), "state.sqlite") }
}

// What a daemon started on this state file would load.
async function reopened(storePath: string): Promise<WorkspaceSnapshot> {
  const store = new SqliteWorkspaceStore(storePath, demoWorkspace)
  try {
    return store.load()
  } finally {
    await store.close()
  }
}

// A card that can take a standing rule, beside the one start() puts up.
async function ruleCard({ snapshot, emit }: Started, workspace: string): Promise<Card> {
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt" } }))
  writeFileSync(join(workspace, "notes.txt"), "notes\n")
  emit({ type: "approval-requested", requestId: 42, threadId, turnId: "turn-billing", itemId: "call_show", command: "pnpm run show" })
  await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(2))
  return (await snapshot()).approvals.find((approval) => approval.providerRequestId === 42)!
}

// The save that carries the person's decision on this card.
function decisionWrite(written: WorkspaceSnapshot, card: Card): boolean {
  return written.thread.some((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}-`))
}

type Started = Awaited<ReturnType<typeof start>>
type Card = WorkspaceSnapshot["approvals"][number]

const answeredNotDenied = "A request in this session was answered outside Domovoi, so Domovoi did not deny it."

// A second card, with a reason, beside the one start() puts up.
async function secondCard({ snapshot, emit }: Started): Promise<{ card: Card; other: Card }> {
  emit({
    type: "approval-requested", requestId: 42, threadId, turnId: "turn-billing", itemId: "call_clean",
    command: "rm -rf dist", reason: "Clean the build output",
  })
  await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(2))
  const approvals = (await snapshot()).approvals
  return {
    card: approvals.find((approval) => approval.providerRequestId === 42)!,
    other: approvals.find((approval) => approval.providerRequestId === 41)!,
  }
}

async function incidentEntry(append: Started["append"]) {
  await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({
    action: "provider.approval-answered-elsewhere",
  })))
  const entries = append.mock.calls.map(([input]) => input).filter((input) => input.action === "provider.approval-answered-elsewhere")
  expect(entries).toHaveLength(1)
  return entries[0]!
}

// Round 8, ruling Q279: the entry says the match was made against the cards
// shown when the report arrived.
function auditFacts(card: Card): string {
  return [
    "match=currently-shown",
    `approval=${card.id}`,
    `risk=${card.risk}`,
    `operation=${JSON.stringify(card.operation)}`,
    `command=${JSON.stringify(card.command)}`,
    `directory=${JSON.stringify(card.directory)}`,
    `affects=${JSON.stringify(card.affects)}`,
  ].join(" ")
}

function noticeFacts(card: Card): string {
  return `The answer was to the request "${card.operation}", command ${card.command}, in ${card.directory}. ${card.affects} ${
    card.risk === "hard-gate" ? "It was a hard gate." : "It was not a hard gate."
  }`
}

describe("an approval answered outside Domovoi", () => {
  it("fails the session with its own failure, drops its cards, says why and records it", async () => {
    const { provider, rpc, snapshot, session, append, emit } = await start()
    expect(provider.resumeThread).toHaveBeenCalledOnce()

    emit({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-billing",
        turn: { id: "turn-billing", status: "failed", error: answeredElsewhere.message },
        failure: answeredElsewhere,
      },
    })
    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_1", reply: "once" })
    // The adapter then restarts the server, which every session on it hears.
    emit({ type: "provider-disconnected", reason: restarted })

    await waitForDaemon(async () => expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.disconnected",
    })))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
    }))
    expect(append).toHaveBeenCalledWith({
      actor: { kind: "provider", provider: "opencode", providerThreadId: threadId },
      action: "provider.approval-answered-elsewhere",
      outcome: "denied",
      sessionId,
      projectId: (await session()).projectId,
      target: "per_1",
      detail: "reply=once match=currently-shown approval=none",
    })
    const stopped = await session()
    expect(stopped.state).toBe("failed")
    expect(stopped.providerFailure).toEqual(answeredElsewhere)
    expect(stopped).not.toHaveProperty("activeTurnId")
    // Codex review of #691, P1: the provider session may hold approvals made
    // elsewhere, so it is never resumed.
    expect(stopped).not.toHaveProperty("providerThreadId")
    const after = await snapshot()
    expect(after.approvals).toEqual([])
    expect(after.thread).toContainEqual(expect.objectContaining({ sessionId, kind: "system", body: notice }))
    expect(after.thread.filter((item) => item.sessionId === sessionId && item.kind === "system" && item.body.includes("disconnected")))
      .toEqual([])

    // It continues only in a new provider session, the way a quarantined
    // session does: a send is refused until the provider thread is restarted.
    const refused = await rpc("session.send", { sessionId, prompt: "go on", client: "desktop" })
    expect(refused.error?.message).toBe("Session is not ready for agent turns")
    const restart = await rpc("session.restartProviderThread", { sessionId, client: "desktop" })
    expect(restart.error?.message).toBeUndefined()
    expect(provider.startThread).toHaveBeenCalledOnce()
    expect((await session()).providerThreadId).toBe("ses_fresh")
    const again = await rpc("session.send", { sessionId, prompt: "go on", client: "desktop" })
    expect(again.error?.message).toBeUndefined()
    expect(provider.resumeThread).toHaveBeenCalledOnce()
  })

  // Codex review of #691 at a609034e, P2: with several cards up, the record
  // says which one was answered and what it asked, before the cards go.
  it("names the answered card and its facts in the notice and the audit entry", async () => {
    const context = await start()
    const { snapshot, emit } = context
    const { card, other } = await secondCard(context)

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "always" })

    const entry = await incidentEntry(context.append)
    expect(entry.target).toBe("per_2")
    expect(entry.detail).toBe(`reply=always ${auditFacts(card)}`)
    expect(entry.detail).not.toContain(other.id)
    const after = await snapshot()
    expect(after.approvals).toEqual([])
    const stoppedNotice = after.thread.find((item) => item.sessionId === sessionId && item.kind === "system" && item.body === notice)
    expect(stoppedNotice?.kind === "system" ? stoppedNotice.detail : undefined).toContain(noticeFacts(card))
  })

  // Codex review of #691, round 6, P2 (ruling Q271): the card's facts are
  // read when the report arrives. An archive or an emergency stop that clears
  // the cards before the report is handled leaves them in the record, and
  // gives the answered card no deny receipt: Domovoi did not deny it.
  it("keeps the answered card's facts, and denies it no receipt, when an archive clears the cards first", async () => {
    const context = await start()
    const { provider, rpc, snapshot, emit } = context
    const { card, other } = await secondCard(context)
    let releaseDeny!: () => void
    provider.resolveApproval.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseDeny = resolve }))
    const archived = rpc("session.archive", { sessionId, client: "desktop" })
    await waitForDaemon(() => expect(provider.resolveApproval).toHaveBeenCalledOnce())

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "always" })
    releaseDeny()
    expect((await archived).error?.message).toBeUndefined()

    const entry = await incidentEntry(context.append)
    expect(entry.detail).toBe(`reply=always ${auditFacts(card)}`)
    const after = await snapshot()
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId, kind: "receipt", decision: "deny", operation: other.operation, explanation: "Session archived",
    }))
    expect(after.thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}-`))).toEqual([])
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(42, "deny")
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId, kind: "system", body: answeredNotDenied, detail: expect.stringContaining(noticeFacts(card)),
    }))
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId, kind: "system", body: "An approval in this session was answered outside Domovoi.",
      detail: expect.stringContaining(noticeFacts(card)),
    }))
  })

  // The person's answer to the same card, sent before the report arrived and
  // handled after it, is refused: the provider already has an answer, and a
  // receipt would say the person decided what someone else did.
  it("refuses a person's answer to a card already answered outside Domovoi", async () => {
    const context = await start()
    const { provider, workspaceService, rpc, snapshot, emit } = context
    const { card, other } = await secondCard(context)
    // An allow takes a checkpoint first; holding it holds the session's queue.
    let releaseCheckpoint!: () => void
    workspaceService.snapshot.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCheckpoint = () => resolve({ commit: "c".repeat(40), changedFiles: [] })
    }))
    const first = rpc("approval.resolve", { approvalId: other.id, decision: "allow-once", revision: other.revision })
    await waitForDaemon(() => expect(workspaceService.snapshot).toHaveBeenCalledOnce())
    const second = rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision })
    // Answered outside the queue, after the request above was queued.
    expect((await rpc("permission.hardGates", {})).error).toBeUndefined()

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "once" })
    releaseCheckpoint()

    expect((await first).error?.message).toBeUndefined()
    expect((await second).error?.message).toBe("This request was answered outside Domovoi")
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    const entry = await incidentEntry(context.append)
    expect(entry.detail).toBe(`reply=once ${auditFacts(card)}`)
    expect((await snapshot()).thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}`)))
      .toEqual([])
  })

  // Round 7 of the Codex review of #691, P2 (ruling Q274): the person's own
  // answer to the same card is in flight when the report marks it. Nothing of
  // the decision is saved and the provider is not told.
  async function nothingDecided(context: Started, card: Card, storePath: string): Promise<void> {
    const entry = await incidentEntry(context.append)
    expect(entry.detail).toContain(`approval=${card.id}`)
    expect(context.provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    const after = await context.snapshot()
    expect(after.thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}`))).toEqual([])
    expect(after.thread.filter((item) => item.kind === "checkpoint" && item.label.endsWith("before an approved command")))
      .toEqual([])
    expect(after.approvalRules).toEqual([])
    // Nor in the state file, as a daemon started on it would read it.
    const stored = await reopened(storePath)
    expect(stored.thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}`))).toEqual([])
    expect(stored.approvalRules).toEqual([])
  }

  it("refuses the person's standing rule when the card is answered elsewhere during its checkpoint", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { workspaceService, rpc, emit } = context
    const card = await ruleCard(context, paths.workspacePath)
    expect(card).toMatchObject({ risk: "normal", execution: { state: "resolved" } })
    let releaseCheckpoint!: () => void
    workspaceService.snapshot.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCheckpoint = () => resolve({ commit: "c".repeat(40), changedFiles: [] })
    }))
    const decided = rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })
    await waitForDaemon(() => expect(workspaceService.snapshot).toHaveBeenCalledOnce())

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "once" })
    releaseCheckpoint()

    expect((await decided).error?.message).toBe("This request was answered outside Domovoi")
    await nothingDecided(context, card, paths.storePath)
  })

  it("refuses the person's standing rule when the card is answered elsewhere while the decision is saved", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, emit } = context
    const card = await ruleCard(context, paths.workspacePath)
    const save = store.saveAsync.bind(store)
    let held = false
    let releaseSave!: () => void
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (!held && decisionWrite(written, card)) {
        held = true
        await new Promise<void>((resolve) => { releaseSave = resolve })
      }
      await save(written)
    })
    const decided = rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })
    await waitForDaemon(() => expect(held).toBe(true))

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "once" })
    releaseSave()

    expect((await decided).error?.message).toBe("This request was answered outside Domovoi")
    await nothingDecided(context, card, paths.storePath)
  })

  // Round 8 of the Codex review of #691, P2 (ruling Q279): the write that
  // can still be undone carries the decision but never its standing rule.
  // When the undo and every later save fail, a daemon started on the state
  // file finds at most a receipt, never a rule that would answer for it.
  it("leaves no standing rule in the state file when a refused decision cannot be undone", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, emit } = context
    const card = await ruleCard(context, paths.workspacePath)
    const save = store.saveAsync.bind(store)
    let held = false
    let failing = false
    let releaseSave!: () => void
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (failing) throw new Error("disk full")
      if (!held && decisionWrite(written, card)) {
        held = true
        await new Promise<void>((resolve) => { releaseSave = resolve })
        await save(written)
        // The undo of this write and the incident's save both fail.
        failing = true
        return
      }
      await save(written)
    })
    const decided = rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })
    await waitForDaemon(() => expect(held).toBe(true))

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "once" })
    releaseSave()

    expect((await decided).error?.message).toBe("This request was answered outside Domovoi")
    await incidentEntry(context.append)
    expect(context.provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    expect((await context.snapshot()).approvalRules).toEqual([])
    expect((await reopened(paths.storePath)).approvalRules).toEqual([])
  })

  it("keeps no standing rule, and tells the agent nothing, when the rule cannot be saved after the decision", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc } = context
    const card = await ruleCard(context, paths.workspacePath)
    const save = store.saveAsync.bind(store)
    let decisionSaved = false
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (decisionSaved) throw new Error("disk full")
      if (decisionWrite(written, card)) decisionSaved = true
      await save(written)
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error).toEqual({
      code: daemonPersistenceUnavailableErrorCode,
      message: "Domovoi could not save this decision, so the agent was not told",
    })
    expect(context.provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    const after = await context.snapshot()
    expect(after.approvalRules).toEqual([])
    expect(after.approvals.map(({ id }) => id)).toContain(card.id)
    expect((await reopened(paths.storePath)).approvalRules).toEqual([])
  })

  it("keeps the answered card's facts, and denies it no receipt, when an emergency stop clears the cards first", async () => {
    const context = await start()
    const { provider, rpc, snapshot, emit } = context
    const { card, other } = await secondCard(context)
    // A pause holds the session's queue while the report waits behind it.
    let releasePause!: () => void
    provider.interruptTurn.mockImplementationOnce(() => new Promise<void>((resolve) => { releasePause = resolve }))
    const paused = rpc("session.pause", { sessionId, client: "desktop" })
    await waitForDaemon(() => expect(provider.interruptTurn).toHaveBeenCalledOnce())

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_2", requestId: 42, reply: "once" })
    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped.error?.message).toBeUndefined()
    releasePause()
    await paused

    const entry = await incidentEntry(context.append)
    expect(entry.detail).toBe(`reply=once ${auditFacts(card)}`)
    const after = await snapshot()
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId, kind: "receipt", decision: "deny", operation: other.operation, explanation: "Emergency stop",
    }))
    expect(after.thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}-`))).toEqual([])
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(42, "deny")
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId, kind: "system", body: answeredNotDenied, detail: expect.stringContaining(noticeFacts(card)),
    }))
  })

  it("says when the answered permission matched no card it was showing", async () => {
    const { snapshot, append, emit } = await start()

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_unseen", reply: "once" })

    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
      target: "per_unseen",
      detail: "reply=once match=currently-shown approval=none",
    })))
    const stoppedNotice = (await snapshot()).thread.find((item) => item.sessionId === sessionId && item.kind === "system" && item.body === notice)
    // Round 8, ruling Q279: a card already decided is no longer shown, so the
    // notice does not claim Domovoi's own answer never went out.
    expect(stoppedNotice?.kind === "system" ? stoppedNotice.detail : undefined).toContain(
      "The answer matched no request Domovoi was showing in this session. A Domovoi decision may already have been saved or sent before this report; its acceptance was not confirmed.",
    )
  })

  // Codex review of #691 at a609034e, P2: the adapter ends the turn before it
  // reports the reply, so the turn's end holds the queued send first. The held
  // row still says why.
  it("says on the held queued send that an approval was answered outside Domovoi", async () => {
    const { rpc, snapshot, emit } = await start()
    const queued = await rpc("session.send", { sessionId, prompt: "then this", client: "desktop", delivery: "next-turn-replace" })
    expect(queued.error?.message).toBeUndefined()
    expect((await snapshot()).queuedSends?.map(({ state }) => state)).toEqual(["waiting"])

    emit({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-billing",
        turn: { id: "turn-billing", status: "failed", error: answeredElsewhere.message },
        failure: answeredElsewhere,
      },
    })
    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_1", reply: "once" })

    await waitForDaemon(async () => expect((await snapshot()).thread).toContainEqual(expect.objectContaining({ sessionId, body: notice })))
    expect((await snapshot()).queuedSends?.map(({ state, reason }) => ({ state, reason }))).toEqual([{
      state: "held",
      reason: "An approval was answered outside Domovoi, so the queued send was held.",
    }])
  })

  // Codex review of #691 at a609034e, P1: the report waits behind an archive
  // that drops the session's provider thread and makes it read-only. The
  // incident is still recorded against the session the thread belonged to
  // when the report arrived; only the stop itself is the archive's to make.
  it("records the incident for a session archived while the report waited", async () => {
    const { provider, rpc, snapshot, session, append, emit } = await start()
    let releaseInterrupt!: () => void
    provider.interruptTurn.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseInterrupt = resolve }))
    const archived = rpc("session.archive", { sessionId, client: "desktop" })
    await waitForDaemon(() => expect(provider.interruptTurn).toHaveBeenCalledOnce())

    emit({ type: "approval-answered-elsewhere", threadId, turnId: "turn-billing", permissionId: "per_1", reply: "always" })
    releaseInterrupt()
    expect((await archived).error?.message).toBeUndefined()

    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
      sessionId,
      target: "per_1",
    })))
    const after = await snapshot()
    expect(after.thread).toContainEqual(expect.objectContaining({
      sessionId,
      kind: "system",
      body: "An approval in this session was answered outside Domovoi.",
    }))
    // The archive, not the report, decides how the session ends.
    expect((await session()).state).toBe("archived")
    expect((await session()).providerFailure).toBeUndefined()
  })

  it("fails the session when the stop arrives with no turn running", async () => {
    const { session, append, emit } = await start()
    emit({ type: "turn-completed", params: { threadId, turnId: "turn-billing", turn: { id: "turn-billing", status: "completed" } } })
    await waitForDaemon(async () => expect((await session()).state).toBe("idle"))

    emit({ type: "approval-answered-elsewhere", threadId, permissionId: "per_late", reply: "always" })

    await waitForDaemon(async () => expect((await session()).state).toBe("failed"))
    expect((await session()).providerFailure).toEqual(answeredElsewhere)
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.approval-answered-elsewhere",
      target: "per_late",
      detail: "reply=always match=currently-shown approval=none",
    }))
  })
})

// Round 9 of the Codex review of #691 (ruling Q285). A person's Always is
// saved first as a rule pending delivery, which never answers a request, and
// made active only once the agent has been told and was waiting for the
// answer. A stop that cancels the decision while its rule is saved ends it
// without telling the agent and without putting back what the stop removed.
describe("a standing rule and the decision that makes it", () => {
  const activeRules = (snapshot: WorkspaceSnapshot) => snapshot.approvalRules.filter((rule) => rule.status === "active")
  const ruleWrite = (written: WorkspaceSnapshot, card: Card) => written.approvalRules.some((rule) => rule.id.startsWith(`rule-${card.id}-`))
  const receipts = (snapshot: WorkspaceSnapshot, card: Card) =>
    snapshot.thread.filter((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${card.id}-`))

  async function heldRuleWrite(context: Started, card: Card, release: "save" | "fail") {
    const save = context.store.saveAsync.bind(context.store)
    let held = false
    let releaseWrite!: () => void
    vi.spyOn(context.store, "saveAsync").mockImplementation(async (written) => {
      if (!held && ruleWrite(written, card)) {
        held = true
        await new Promise<void>((resolve) => { releaseWrite = resolve })
        if (release === "fail") throw new Error("disk full")
      }
      await save(written)
    })
    const decided = context.rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })
    await waitForDaemon(() => expect(held).toBe(true))
    return { decided, release: () => releaseWrite() }
  }

  async function stopDuring(context: Started, release: () => void) {
    const stopped = context.rpc("system.emergencyStop", { client: "desktop" })
    // The stop has denied the cards it found and interrupted the turn.
    await waitForDaemon(() => expect(context.provider.interruptTurn).toHaveBeenCalled())
    release()
    expect((await stopped).error).toBeUndefined()
  }

  it("tells the agent nothing when an emergency stop cancels the decision while its rule is saved", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const card = await ruleCard(context, paths.workspacePath)
    const { decided, release } = await heldRuleWrite(context, card, "save")

    await stopDuring(context, release)

    expect((await decided).error?.message).toBe("The approval was withdrawn before it could be allowed")
    expect(context.provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    const live = await context.snapshot()
    expect(activeRules(live)).toEqual([])
    expect(receipts(live, card)).toEqual([])
    expect(live.approvals.map(({ id }) => id)).not.toContain(card.id)
    const stored = await reopened(paths.storePath)
    expect(activeRules(stored)).toEqual([])
    expect(receipts(stored, card)).toEqual([])
  })

  it("keeps what an emergency stop removed when the cancelled decision's rule cannot be saved", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const card = await ruleCard(context, paths.workspacePath)
    const { decided, release } = await heldRuleWrite(context, card, "fail")

    await stopDuring(context, release)

    expect((await decided).error).toBeDefined()
    expect(context.provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    const live = await context.snapshot()
    expect(live.approvals).toEqual([])
    expect(activeRules(live)).toEqual([])
    const stored = await reopened(paths.storePath)
    expect(stored.approvals).toEqual([])
    expect(activeRules(stored)).toEqual([])
  })

  it("leaves no active rule in the state file when the agent cannot be told and the undo cannot be saved", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, provider } = context
    const card = await ruleCard(context, paths.workspacePath)
    provider.resolveApproval.mockImplementation((requestId: number) => {
      if (requestId === 42) throw new Error("stdin closed")
    })
    const save = store.saveAsync.bind(store)
    let failing = false
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (failing) throw new Error("disk full")
      await save(written)
      if (ruleWrite(written, card)) failing = true
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error).toEqual({
      code: daemonPersistenceUnavailableErrorCode,
      message: "Domovoi could not save this decision, so the agent was not told",
    })
    expect(activeRules(await context.snapshot())).toEqual([])
    expect(activeRules(await reopened(paths.storePath))).toEqual([])
  })

  it("leaves no active rule in the state file when the rule's save reports failure after writing and the undo fails", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, provider } = context
    const card = await ruleCard(context, paths.workspacePath)
    const save = store.saveAsync.bind(store)
    let failing = false
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (failing) throw new Error("disk full")
      await save(written)
      if (ruleWrite(written, card)) {
        failing = true
        // The snapshot reached the file; a later step of the same save failed.
        throw new Error("project index write failed")
      }
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error).toEqual({
      code: daemonPersistenceUnavailableErrorCode,
      message: "Domovoi could not save this decision, so the agent was not told",
    })
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(42, expect.anything())
    expect(activeRules(await context.snapshot())).toEqual([])
    expect(activeRules(await reopened(paths.storePath))).toEqual([])
  })

  it("makes no rule when the agent is no longer waiting for the request", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { rpc, provider } = context
    const card = await ruleCard(context, paths.workspacePath)
    provider.resolveApproval.mockImplementation((requestId: number) => {
      if (requestId === 42) throw new ApprovalRequestNotPendingError(42)
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error?.message).toBe("The agent is no longer waiting for this approval, so it was not allowed")
    const live = await context.snapshot()
    expect(activeRules(live)).toEqual([])
    expect(receipts(live, card)).toEqual([])
    expect(live.approvalRules).toEqual([])
    const stored = await reopened(paths.storePath)
    expect(activeRules(stored)).toEqual([])
  })

  it("makes the rule active only after the agent has the decision", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, provider } = context
    const card = await ruleCard(context, paths.workspacePath)
    const order: string[] = []
    const save = store.saveAsync.bind(store)
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      const rule = written.approvalRules.find((candidate) => candidate.id.startsWith(`rule-${card.id}-`))
      if (rule && !order.includes(rule.status === "active" ? "active" : "pending")) {
        order.push(rule.status === "active" ? "active" : rule.inactiveReason)
      }
      await save(written)
    })
    provider.resolveApproval.mockImplementation((requestId: number) => {
      if (requestId === 42) order.push("told")
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error).toBeUndefined()
    expect(order).toEqual(["pending-delivery", "told", "active"])
    expect(provider.resolveApproval).toHaveBeenCalledWith(42, "allow-once")
    expect(activeRules(await context.snapshot())).toHaveLength(1)
    expect(activeRules(await reopened(paths.storePath))).toEqual([
      expect.objectContaining({ command: card.command, status: "active" }),
    ])
  })

  // The save here fails before writing, so the state file keeps the pending
  // rule. A save that fails after writing can leave it active there, which
  // is why the message does not say where the rule stands (round 10).
  it("keeps the rule pending, and says the Allow was sent once, when making it active cannot be saved", async () => {
    const paths = onDisk()
    const context = await start(paths)
    const { store, rpc, provider } = context
    const card = await ruleCard(context, paths.workspacePath)
    const save = store.saveAsync.bind(store)
    vi.spyOn(store, "saveAsync").mockImplementation(async (written) => {
      if (written.approvalRules.some((rule) => rule.id.startsWith(`rule-${card.id}-`) && rule.status === "active")) {
        throw new Error("disk full")
      }
      await save(written)
    })

    const decided = await rpc("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision })

    expect(decided.error).toEqual({
      code: daemonPersistenceUnavailableErrorCode,
      message: "Domovoi sent this Allow once, but could not confirm the standing rule was saved. "
        + "It may or may not be in force after Domovoi restarts. Check Standing approval rules in Settings, Permissions and rules.",
    })
    expect(provider.resolveApproval).toHaveBeenCalledWith(42, "allow-once")
    const live = await context.snapshot()
    expect(activeRules(live)).toEqual([])
    expect(live.approvalRules).toEqual([expect.objectContaining({ status: "inactive", inactiveReason: "pending-delivery" })])
    expect(activeRules(await reopened(paths.storePath))).toEqual([])
  })

  it("drops a rule left pending delivery when the daemon starts, and says so", async () => {
    const paths = onDisk()
    const seeded = openCodeSession(paths.workspacePath)
    const execution = resolveCommandExecution({ command: "prisma migrate deploy" })
    if (execution.state !== "resolved") throw new Error("The seeded rule needs a resolved record")
    seeded.approvalRules = [{
      id: "rule-undelivered",
      projectId: seeded.project!.id,
      operation: "Run a command",
      command: "pnpm run show",
      createdBy: "desktop",
      createdAt: "2026-10-01T12:00:00.000Z",
      useCount: 0,
      status: "inactive",
      inactiveReason: "pending-delivery",
      execution,
    }]
    const seed = new SqliteWorkspaceStore(paths.storePath, workspaceSnapshotSchema.parse(seeded))
    await seed.close()

    const context = await start(paths)

    expect((await context.snapshot()).approvalRules).toEqual([])
    expect((await reopened(paths.storePath)).approvalRules).toEqual([])
    expect(context.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "approval-rule.undelivered",
      outcome: "cancelled",
      target: "rule-undelivered",
    }))
  })
})
