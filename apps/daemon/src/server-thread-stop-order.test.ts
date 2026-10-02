import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AuditLog } from "./audit-log.js"
import { OpenCodeSdkAdapter, openCodeBuiltInToolIds, type OpenCodeClient, type OpenCodeEvent } from "./opencode.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"
import { UsageLedger } from "./usage.js"
import type { WorkspaceService } from "./workspace.js"

// Security review round 14 of #687 (ruling Q308): when overlapping
// thread-wide stops defer a turn's end to the last of them, the daemon must
// still hear that end before the incident and the disconnect, which drop the
// session's thread and turn. Otherwise the turn's end finds no turn: the
// session is not stored as failed by it, no provider.turn-completed entry is
// written, and usage ends "interrupted" instead of "failed". The OpenCode
// adapter here is the real one; its server, client and event stream are
// mocks, and no daemon process or provider runs.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratch)
})

const sessionId = "session-billing"
const threadId = "ses_billing"
const turnId = "msg_turn"
const answeredElsewhere = {
  kind: "approval-answered-elsewhere",
  action: "review-changes",
  message: "An approval was answered outside Domovoi",
  retryable: false,
} as const

class EventStream implements AsyncIterable<OpenCodeEvent> {
  #events: OpenCodeEvent[] = []
  #waiters: Array<(result: IteratorResult<OpenCodeEvent>) => void> = []
  #closed = false

  emit(event: OpenCodeEvent): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.#events.push(event)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  get closed(): boolean {
    return this.#closed
  }

  [Symbol.asyncIterator](): AsyncIterator<OpenCodeEvent> {
    return {
      next: async () => {
        const event = this.#events.shift()
        if (event) return { value: event, done: false }
        if (this.#closed) return { value: undefined, done: true }
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

// A second OpenCode session, in a directory of its own, on the same server.
const otherSessionId = "session-audit"
const otherThreadId = "ses_audit"

// A third OpenCode session, in a third directory (security review round 16
// of #687).
const thirdSessionId = "session-onboarding"
const thirdThreadId = "ses_onboarding"

function openCodeSession(workspacePath: string, otherPath?: string, thirdPath?: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessions: Array<[string, string, string]> = [[sessionId, threadId, workspacePath]]
  if (otherPath) sessions.push([otherSessionId, otherThreadId, otherPath])
  if (thirdPath) sessions.push([thirdSessionId, thirdThreadId, thirdPath])
  for (const [id, thread, path] of sessions) {
    const session = snapshot.sessions.find((candidate) => candidate.id === id)!
    session.runtime = { ...session.runtime, provider: "opencode", model: "anthropic/sonnet", permissionMode: "build", auto: false }
    session.state = "idle"
    session.workspacePath = path
    session.providerThreadId = thread
    delete session.activeTurnId
  }
  snapshot.approvals = []
  snapshot.approvalRules = []
  return workspaceSnapshotSchema.parse(snapshot)
}

// `third`: "send" starts the third session's turn with the others; "idle"
// leaves it unloaded until the test sends to it. `noticeWaitMs` shortens the
// adapter's bound on a pending disconnect. Each server the factory starts is
// its own handle; the first one's stop waits for `confirmOldStop`.
async function start({ second = false, third, noticeWaitMs, manualOldStop = noticeWaitMs !== undefined }: {
  second?: boolean
  third?: "send" | "idle"
  noticeWaitMs?: number
  manualOldStop?: boolean
} = {}) {
  const workspacePath = await mkdtemp(join(tmpdir(), "domovoi-stop-order-"))
  scratch.push(workspacePath)
  const otherPath = second ? await mkdtemp(join(tmpdir(), "domovoi-stop-order-other-")) : undefined
  if (otherPath) scratch.push(otherPath)
  const thirdPath = third ? await mkdtemp(join(tmpdir(), "domovoi-stop-order-third-")) : undefined
  if (thirdPath) scratch.push(thirdPath)
  const stream = new EventStream()
  // Each directory has its own event stream.
  const otherStream = new EventStream()
  const thirdStream = new EventStream()
  const reopened: EventStream[] = []
  // Aborts wait for a manual answer, by provider session.
  const waiting = new Map<string, Array<(ok: boolean) => void>>()
  let replyPost: { refuse: () => void } | undefined
  const client = {
    config: {
      get: vi.fn(async () => ({ data: { model: "anthropic/sonnet" } })),
      providers: vi.fn(async () => ({
        data: {
          default: { anthropic: "sonnet" },
          providers: [{
            id: "anthropic",
            name: "Anthropic",
            models: { sonnet: { id: "sonnet", providerID: "anthropic", name: "Sonnet", capabilities: { reasoning: true }, status: "active" } },
          }],
        },
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: threadId } })),
      get: vi.fn(async (...args: unknown[]) => ({ data: { id: (args[0] as { path: { id: string } }).path.id } })),
      delete: vi.fn(async () => ({ data: true })),
      abort: vi.fn((...args: unknown[]) => {
        const id = (args[0] as { path: { id: string } }).path.id
        return new Promise<{ data: boolean }>((resolve, reject) => {
          const answers = waiting.get(id) ?? []
          answers.push((ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused"))))
          waiting.set(id, answers)
        })
      }),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async (_options?: unknown): Promise<{ data: unknown; response?: Response }> => ({ data: [] })),
      status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })),
    },
    event: {
      subscribe: vi.fn(async (...args: unknown[]) => {
        const directory = (args[0] as { query?: { directory?: string } } | undefined)?.query?.directory
        if (directory !== undefined && directory === thirdPath) return { stream: thirdStream }
        // A directory subscribed again after its stream closed gets a new one.
        if (directory !== undefined && directory === otherPath) {
          const latest = reopened.at(-1) ?? otherStream
          if (!latest.closed) return { stream: latest }
          const fresh = new EventStream()
          reopened.push(fresh)
          return { stream: fresh }
        }
        return { stream }
      }),
    },
    postSessionIdPermissionsPermissionId: vi.fn(() => new Promise<{ data: boolean }>((_resolve, reject) => {
      replyPost = { refuse: () => reject(new Error("refused")) }
    })),
    mcp: { status: vi.fn(async () => ({ data: {} })) },
    tool: { ids: vi.fn(async () => ({ data: [...openCodeBuiltInToolIds] })) },
    app: {
      agents: vi.fn(async () => ({
        data: ["build", "plan", "domovoi-auto", "domovoi-ask"].map((name) => ({ name, mode: "primary", permission: [{ permission: "*", pattern: "*", action: "ask" }] })),
      })),
    },
  } satisfies OpenCodeClient
  let confirmOldStop: (stopped: boolean) => void = () => {}
  const oldServer = {
    close: vi.fn(),
    stop: vi.fn(() => (!manualOldStop
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => { confirmOldStop = resolve }))),
  }
  const replacementServer = { close: vi.fn(), stop: vi.fn(async () => true) }
  const servers = [oldServer, replacementServer]
  const factory = vi.fn(async () => ({ client, server: servers.shift() ?? replacementServer }))
  const adapter = new OpenCodeSdkAdapter(factory, () => turnId, undefined, noticeWaitMs === undefined ? {} : { noticeWaitMs })
  const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
    id: `audit-${append.mock.calls.length}`,
    occurredAt: "2026-10-01T12:00:00.000Z",
    ...input,
  }))
  const auditLog = {
    append,
    query: vi.fn(() => ({ entries: [], hasMore: false })),
    export: vi.fn(() => ({ format: "jsonl" as const, exportedAt: "2026-10-01T12:00:00.000Z", content: "", entryCount: 0, hasMore: false })),
  } satisfies AuditLog
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(async () => ({ commit: "a".repeat(40), changedFiles: [] })),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
    archiveSessionWorkspace: vi.fn(async () => {}),
  } satisfies WorkspaceService
  const usageLedger = new UsageLedger()
  const store = new SqliteWorkspaceStore(":memory:", openCodeSession(workspacePath, otherPath, thirdPath))
  const daemon = new DomovoiDaemon({
    port: 0, store, auditLog, usageLedger,
    agents: { opencode: adapter }, workspaceService, errorSink: vi.fn(),
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
  await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
  if (second) {
    const sentOther = await rpc("session.send", { sessionId: otherSessionId, prompt: "audit it", client: "desktop" })
    expect(sentOther.error?.message).toBeUndefined()
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
  }
  const sendThird = () => rpc("session.send", { sessionId: thirdSessionId, prompt: "onboard it", client: "desktop" })
  if (third === "send") {
    expect((await sendThird()).error?.message).toBeUndefined()
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(3))
  }
  const answer = async (id: string) => {
    await waitForDaemon(() => expect(waiting.get(id)?.length ?? 0).toBeGreaterThan(0))
    waiting.get(id)!.shift()!(true)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
  const sessionById = async (id: string) => (await snapshot()).sessions.find((candidate) => candidate.id === id)!
  return {
    client, stream, otherStream, thirdStream, sendThird, sessionById,
    rpc, snapshot, session, append, usageLedger, answer, settle,
    factory, oldServer, replacementServer, confirmOldStop: (stopped: boolean) => confirmOldStop(stopped),
    pendingAborts: (id: string) => waiting.get(id)?.length ?? 0,
    refuseReply: () => replyPost!.refuse(),
  }
}

type Started = Awaited<ReturnType<typeof start>>

async function expectFailedTurn({ session, append, usageLedger }: Started) {
  // The incident reached the daemon in every case.
  await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.approval-answered-elsewhere" })))
  await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed" })))
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed", outcome: "failed", sessionId }))
  const stopped = await session()
  expect(stopped.state).toBe("failed")
  expect(stopped.providerFailure).toEqual(answeredElsewhere)
  expect(usageLedger.lookup({ provider: "opencode", threadId, turnId })?.accounting?.status).toBe("failed")
}

describe("a turn ended by overlapping thread stops, through the daemon", () => {
  it("is stored failed when a closed stream's stop settles before a later approval stop", async () => {
    const started = await start()
    const { stream, client, rpc, snapshot, answer, settle, pendingAborts, refuseReply } = started
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: threadId, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [], tool: { messageID: "msg_1", callID: "call_1" } },
    })
    await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
    const card = (await snapshot()).approvals[0]!
    expect((await rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "desktop" })).error).toBeUndefined()
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    // The server reports the reply before it answers the request.
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
    await settle()
    stream.close()
    await answer(threadId)
    await settle()
    // The answer fails, so the reply was someone else's: a second stop.
    refuseReply()
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    await answer("ses_child")
    await settle()
    await answer(threadId)
    await expectFailedTurn(started)
  })

  it("is stored failed when an approval stop settles while a closed stream's stop and the server stop are pending", async () => {
    const started = await start()
    const { stream, answer, settle } = started
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
    await settle()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    await settle()
    stream.close()
    await settle()
    await answer(threadId)
    await settle()
    await answer("ses_child")
    await expectFailedTurn(started)
  })

  // Security review round 15 of #687 (ruling Q310): the daemon takes a
  // disconnect as provider-wide, so a disconnect of one directory waits for
  // a held turn in another.
  it("is stored failed when another directory's stream closes while its approval stop is pending", async () => {
    const started = await start({ second: true })
    const { stream, otherStream, append, usageLedger, session, answer, settle, pendingAborts } = started
    // Session A: an approval answered elsewhere; its abort stays pending.
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    // Session B's directory stream closes, and B's abort completes.
    otherStream.close()
    await answer(otherThreadId)
    await settle()
    await answer(threadId)
    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed", sessionId })))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed", outcome: "failed", sessionId }))
    const stopped = await session()
    expect(stopped.state).toBe("failed")
    expect(stopped.providerFailure).toEqual(answeredElsewhere)
    expect(usageLedger.lookup({ provider: "opencode", threadId, turnId })?.accounting?.status).toBe("failed")
    // The disconnect reached the daemon after A's turn ended.
    const actions = append.mock.calls.map(([input]) => input)
    const completed = actions.findIndex((input) => input.action === "provider.turn-completed" && input.sessionId === sessionId)
    const disconnected = actions.findIndex((input) => input.action === "provider.disconnected")
    expect(disconnected).toBeGreaterThan(completed)
  })

  // Security review round 16 of #687 (ruling Q312): a disconnect waiting on
  // held turns checks again before it goes out, and holds new prompts while
  // it waits, so a turn held during the wait also ends first.
  const v2 = (target: EventStream, thread: string) => target.emit({ type: "permission.v2.asked", properties: { sessionID: thread, id: `per_v2_${thread}` } })

  async function expectStoredFailed({ append, usageLedger, sessionById }: Started, id: string, thread: string) {
    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.turn-completed", outcome: "failed", sessionId: id })))
    expect((await sessionById(id)).state).toBe("failed")
    expect(usageLedger.lookup({ provider: "opencode", threadId: thread, turnId })?.accounting?.status).toBe("failed")
  }

  it("ends a turn held during a pending disconnect before that disconnect", async () => {
    const started = await start({ second: true, third: "send" })
    const { stream, otherStream, thirdStream, append, answer, settle, pendingAborts } = started
    v2(stream, threadId)
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    otherStream.close()
    await answer(otherThreadId)
    await settle()
    // C, already running, is held while B's disconnect waits on A.
    v2(thirdStream, thirdThreadId)
    await waitForDaemon(() => expect(pendingAborts(thirdThreadId)).toBe(1))
    await answer(threadId)
    await settle()
    await answer(thirdThreadId)
    await expectStoredFailed(started, thirdSessionId, thirdThreadId)
    const actions = append.mock.calls.map(([input]) => input)
    const completed = actions.findIndex((input) => input.action === "provider.turn-completed" && input.sessionId === thirdSessionId)
    const disconnected = actions.findIndex((input) => input.action === "provider.disconnected")
    expect(disconnected).toBeGreaterThan(completed)
  })

  // The report's case: C is loaded, starts a turn and gets a request it
  // cannot answer while B's disconnect waits on A.
  it("ends a late-loaded session's held turn before a pending disconnect", async () => {
    const started = await start({ second: true, third: "idle" })
    const { stream, otherStream, thirdStream, append, sendThird, answer, settle, pendingAborts } = started
    v2(stream, threadId)
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    otherStream.close()
    await answer(otherThreadId)
    await settle()
    const sent = sendThird()
    await settle()
    v2(thirdStream, thirdThreadId)
    await waitForDaemon(() => expect(pendingAborts(thirdThreadId)).toBe(1))
    await answer(threadId)
    await settle()
    await answer(thirdThreadId)
    await sent
    await expectStoredFailed(started, thirdSessionId, thirdThreadId)
    const actions = append.mock.calls.map(([input]) => input)
    const completed = actions.findIndex((input) => input.action === "provider.turn-completed" && input.sessionId === thirdSessionId)
    const disconnected = actions.findIndex((input) => input.action === "provider.disconnected")
    expect(disconnected).toBeGreaterThan(completed)
  })

  // Security review round 17 of #687 (ruling Q313): requests a session with
  // no turn cannot answer hold no disconnect, so B, whose stream closed,
  // resumes on its next send once the turns held at the time have ended.
  it("lets the dropped directory's session resume once the held turns have ended", async () => {
    const started = await start({ second: true, third: "send" })
    const { client, stream, otherStream, thirdStream, append, rpc, answer, settle, pendingAborts } = started
    v2(stream, threadId)
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    otherStream.close()
    await answer(otherThreadId)
    await settle()
    v2(thirdStream, thirdThreadId)
    await waitForDaemon(() => expect(pendingAborts(thirdThreadId)).toBe(1))
    await answer(threadId)
    await settle()
    // A has no turn now; its next such request holds nothing.
    v2(stream, threadId)
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    await answer(thirdThreadId)
    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.disconnected" })))
    const resumes = client.session.get.mock.calls.length
    const sent = await rpc("session.send", { sessionId: otherSessionId, prompt: "audit again", client: "desktop" })
    expect(sent.error?.message).toBeUndefined()
    expect(client.session.get.mock.calls.length).toBeGreaterThan(resumes)
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({ path: { id: otherThreadId } })))
  })

  // Security review round 18 of #687 (ruling Q314): when the bound runs out,
  // the daemon hears one disconnect. The forced server stop sends none of
  // its own, so a recovery turn started on the replacement server is not
  // ended by a second one.
  it("keeps a recovery turn on the replacement server after the bound runs out", async () => {
    const started = await start({ second: true, noticeWaitMs: 300 })
    const { client, stream, otherStream, append, rpc, sessionById, answer, settle, pendingAborts, factory, oldServer, replacementServer, confirmOldStop } = started
    v2(stream, threadId)
    await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
    otherStream.close()
    await answer(otherThreadId)
    // The bound runs out: the old server is being stopped, the disconnect is out.
    await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.disconnected" })))
    expect(oldServer.stop).toHaveBeenCalled()
    await answer(threadId)
    // Recovery: the send waits for the old server's stop, then starts the
    // replacement, resumes B and sends its new turn.
    const sent = rpc("session.send", { sessionId: otherSessionId, prompt: "audit again", client: "desktop" })
    await settle()
    expect(factory).toHaveBeenCalledTimes(1)
    confirmOldStop(true)
    expect((await sent).error?.message).toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(2)
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({ path: { id: otherThreadId } })))
    await settle()
    await settle()
    expect(append.mock.calls.filter(([input]) => input.action === "provider.disconnected")).toHaveLength(1)
    const recovered = await sessionById(otherSessionId)
    expect(recovered.state).not.toBe("failed")
    expect(recovered.activeTurnId).toBeDefined()
    expect(replacementServer.stop).not.toHaveBeenCalled()
  })

  // Security review round 19 of #687 (ruling Q315): one disconnect per
  // server. A stop that was already retiring the old server when the
  // 30 second bound ran out sends no second disconnect once that
  // retirement confirms, so B's recovery turn on the replacement survives.
  it("sends one disconnect when an earlier stop was retiring the server as the bound ran out", async () => {
    const started = await start({ second: true, third: "send", manualOldStop: true })
    const { client, stream, otherStream, thirdStream, append, rpc, sessionById, answer, pendingAborts, factory, oldServer, replacementServer, confirmOldStop } = started
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
      const sendTo = async (id: string) => {
        const sent = await rpc("session.send", { sessionId: id, prompt: "again", client: "desktop" })
        expect(sent.error?.message).toBeUndefined()
      }
      // B's disconnect waits behind A's held turn.
      v2(stream, threadId)
      await waitForDaemon(() => expect(pendingAborts(threadId)).toBe(1))
      otherStream.close()
      await answer(otherThreadId)
      await tick(10)
      // Held turns alternate between C and A, so the disconnect keeps waiting.
      await tick(8_000)
      v2(thirdStream, thirdThreadId)
      await tick(10)
      await answer(threadId)
      await tick(8_000)
      await sendTo(sessionId)
      v2(stream, threadId)
      await tick(10)
      await answer(thirdThreadId)
      await tick(8_000)
      await sendTo(thirdSessionId)
      v2(thirdStream, thirdThreadId)
      await tick(10)
      await answer(threadId)
      expect(append.mock.calls.filter(([input]) => input.action === "provider.disconnected")).toHaveLength(0)
      // At about 29.4 s an approval answered elsewhere on A starts a stop of
      // the old server, whose retirement stays pending.
      await tick(5_300)
      stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
      await answer(threadId)
      await tick(50)
      expect(oldServer.stop).toHaveBeenCalled()
      // At 30 s the bound runs out: B's disconnect goes out.
      await tick(1_000)
      await waitForDaemon(() => expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "provider.disconnected" })))
      // Recovery waits on the old server's retirement, then starts the
      // replacement and sends B's turn.
      const sent = rpc("session.send", { sessionId: otherSessionId, prompt: "audit again", client: "desktop" })
      await tick(50)
      confirmOldStop(true)
      await tick(50)
      expect((await sent).error?.message).toBeUndefined()
      expect(factory).toHaveBeenCalledTimes(2)
      await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({ path: { id: otherThreadId } })))
      await tick(200)
      expect(append.mock.calls.filter(([input]) => input.action === "provider.disconnected")).toHaveLength(1)
      const recovered = await sessionById(otherSessionId)
      expect(recovered.state).not.toBe("failed")
      expect(recovered.activeTurnId).toBeDefined()
      expect(replacementServer.stop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
