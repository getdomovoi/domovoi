import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  demoWorkspace,
  protocolVersion,
  sessionHistoryPageSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon, workspaceSnapshotForClient } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import { usageIdentity } from "./usage-accounting.js"
import { UsageLedger } from "./usage.js"

// Ruling Q401: the snapshot both desktop and tablet draw carries each linked
// turn's start, end and status, derived from the usage ledger and never
// stored. A turn the daemon lost to its own restart has no end time.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const sessionId = "session-billing"

function workspace(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  snapshot.approvals = []
  snapshot.annotations = []
  return workspaceSnapshotSchema.parse(snapshot)
}

async function start(options: { snapshot?: WorkspaceSnapshot, ledger?: UsageLedger, errorSink?: (report: unknown) => void } = {}) {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-1"), steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const store = new SqliteWorkspaceStore(":memory:", options.snapshot ?? workspace())
  const daemon = new DomovoiDaemon({
    port: 0, store, agents: { codex: provider }, errorSink: options.errorSink ?? vi.fn(),
    usageLedger: options.ledger ?? new UsageLedger(":memory:"),
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
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<{ result?: unknown, error?: { message: string } }>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve as (message: Record<string, unknown>) => void)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await rpc("system.hello", { client: "tablet", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
  const snapshot = async () => workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
  return { rpc, snapshot, store, emit: (event: AgentEvent) => emit(event) }
}

describe("the snapshot's turns", () => {
  it("start when a message dispatches a turn and end when the provider ends it", async () => {
    const { rpc, snapshot, store, emit } = await start()
    const sent = await rpc("session.send", { sessionId, prompt: "Begin", client: "tablet" })
    expect(sent.error).toBeUndefined()
    const dispatched = workspaceSnapshotSchema.parse(sent.result)
    const message = dispatched.thread.findLast((item) => item.kind === "user" && item.sessionId === sessionId)!
    expect(message.turnId).toMatch(/^[a-f0-9]{64}$/)
    expect(dispatched.turns).toEqual([{ id: message.turnId, sessionId, ordinal: 1, startedAt: message.createdAt, status: "pending" }])

    emit({ type: "turn-completed", params: { threadId: "thread-billing", turn: { id: "turn-1", status: "completed" } } })
    await waitForDaemon(async () => expect((await snapshot()).turns?.[0]?.status).toBe("completed"))
    const [ended] = (await snapshot()).turns!
    expect(ended).toMatchObject({ id: message.turnId, startedAt: message.createdAt, status: "completed" })
    expect(Date.parse(ended!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(message.createdAt))

    // Derived for clients only: the stored workspace has no turns.
    expect(store.load()).not.toHaveProperty("turns")
  })

  it("leave out an end that a daemon restart cannot know, which history marks as recorded at the restart", async () => {
    const ledger = new UsageLedger(":memory:")
    const startedAt = "2026-10-02T12:00:00.000Z"
    const dispatch = { sessionId, provider: "codex", model: "gpt-5.6-sol", threadId: "thread-billing", turnId: "turn-lost", startedAt }
    ledger.begin(dispatch)
    const turnId = usageIdentity(dispatch)
    const snapshot = workspace()
    snapshot.thread.push({ id: "user-lost", sessionId, kind: "user", body: "Run it", turnId, createdAt: startedAt })

    const daemon = await start({ snapshot, ledger })
    const [lost] = (await daemon.snapshot()).turns!.filter((turn) => turn.id === turnId)
    expect(lost).toEqual({ id: turnId, sessionId, ordinal: 1, startedAt, status: "interrupted" })

    const history = sessionHistoryPageSchema.parse((await daemon.rpc("session.history", { sessionId, limit: 50 })).result)
    expect(history.items.find((item) => item.sourceId === "user-lost")?.turn).toMatchObject({
      status: "interrupted", completedAtSource: "daemon-restart",
    })
  })

  it("are absent when the thread links no turn", async () => {
    const { snapshot } = await start()
    expect(await snapshot()).not.toHaveProperty("turns")
  })

  // Review P3-5: a turn id the ledger answers twice, in one session or in two,
  // appears once, so it can never make the snapshot fail its schema.
  it("list a turn id once, however often the ledger answers it", () => {
    const snapshot = workspace()
    const turnId = "e".repeat(64)
    const other = snapshot.sessions.find((session) => session.id !== sessionId)!.id
    snapshot.thread.push(
      { id: "user-a", sessionId, kind: "user", body: "A", turnId, createdAt: "2026-10-02T12:00:00.000Z" },
      { id: "user-b", sessionId: other, kind: "user", body: "B", turnId, createdAt: "2026-10-02T12:00:00.000Z" },
    )
    const turn = (session: string) => ({
      id: turnId, sessionId: session, ordinal: 1, startedAt: "2026-10-02T12:00:00.000Z", provider: "codex",
      requestedModel: "model", reportedModels: [], status: "pending" as const, coverage: "pending" as const,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costSource: "unavailable" as const },
      recordedToolCount: 0,
    })
    const client = workspaceSnapshotForClient(snapshot, (session) => [turn(session), turn(session)])
    expect(client.turns?.map((entry) => entry.id)).toEqual([turnId])
    expect(workspaceSnapshotSchema.safeParse(client).success).toBe(true)
  })
})

describe("a usage ledger that cannot be read", () => {
  // Review P3-6: the snapshot still goes out without turns, and the failure is
  // reported once rather than on every snapshot.
  it("leaves turns out and reports once", async () => {
    const ledger = new UsageLedger(":memory:")
    const turns = vi.spyOn(ledger, "turns").mockImplementation(() => { throw new Error("ledger unreadable") })
    const errorSink = vi.fn()
    const snapshot = workspace()
    snapshot.thread.push({ id: "user-linked", sessionId, kind: "user", body: "Run it", turnId: "f".repeat(64), createdAt: "2026-10-02T12:00:00.000Z" })
    const { snapshot: read } = await start({ snapshot, ledger, errorSink })
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await read()).not.toHaveProperty("turns")
    expect(turns.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(errorSink.mock.calls.filter(([report]) => (report as { context?: string }).context === "Domovoi could not read turn times for a snapshot"))
      .toHaveLength(1)
  })
})
