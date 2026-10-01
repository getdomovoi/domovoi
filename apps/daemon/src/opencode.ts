import { randomBytes } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import {
  createOpencodeClient,
  type Config,
} from "@opencode-ai/sdk"
import type { ApprovalDecision, ProviderFailure, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { approvalAnsweredElsewhereFailure as approvalAnsweredElsewhere } from "./provider-failures.js"
import { normalizeProviderUsage } from "./usage.js"
import { createAuthenticatedEmbeddedRuntime, embeddedServerCommand, type EmbeddedServer } from "./embedded-server.js"
import { projectInstructions } from "./project-instructions.js"
import { PublicRpcError } from "./rpc-errors.js"

// JSON-RPC invalid params, the code the daemon gives a refusal a person can act on.
const invalidParams = -32602

type OpenCodeResult<T> = { data?: T; error?: unknown }

type OpencodeSdkClient = ReturnType<typeof createOpencodeClient>
type MethodOptions<T extends (...args: never[]) => unknown> = Parameters<T>[0]

export type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

export type OpenCodeClient = {
  config: {
    get(options?: MethodOptions<OpencodeSdkClient["config"]["get"]>): Promise<OpenCodeResult<unknown>>
    providers(
      options?: MethodOptions<OpencodeSdkClient["config"]["providers"]>,
    ): Promise<OpenCodeResult<unknown>>
  }
  session: {
    create(options: MethodOptions<OpencodeSdkClient["session"]["create"]>): Promise<OpenCodeResult<unknown>>
    get(options: MethodOptions<OpencodeSdkClient["session"]["get"]>): Promise<OpenCodeResult<unknown>>
    delete(options: MethodOptions<OpencodeSdkClient["session"]["delete"]>): Promise<OpenCodeResult<unknown>>
    abort(options: MethodOptions<OpencodeSdkClient["session"]["abort"]>): Promise<OpenCodeResult<unknown>>
    promptAsync(
      options: MethodOptions<OpencodeSdkClient["session"]["promptAsync"]>,
    ): Promise<OpenCodeResult<unknown>>
    // `before` pages backwards through a session (opencode 1.18, kilo 7.7);
    // the next page's cursor comes back in the X-Next-Cursor header.
    messages(options: {
      path: { id: string }
      query: { directory: string; limit?: number; before?: string }
      throwOnError: true
    }): Promise<OpenCodeResult<unknown> & { response?: Response }>
  }
  event: {
    subscribe(options?: MethodOptions<OpencodeSdkClient["event"]["subscribe"]>): Promise<unknown>
  }
  postSessionIdPermissionsPermissionId(
    options: MethodOptions<OpencodeSdkClient["postSessionIdPermissionsPermissionId"]>,
  ): Promise<OpenCodeResult<unknown>>
}

type OpenCodeConfig = { model?: string }

type OpenCodeCatalog = {
  providers: Array<{
    id: string
    name: string
    models: Record<string, {
      id: string
      name: string
      status?: string
      capabilities?: { reasoning?: boolean }
    }>
  }>
  default: Record<string, string>
}

type OpenCodeServer = Pick<EmbeddedServer, "close" | "stop" | "processGroup">

export type OpenCodeFactory = () => Promise<{
  client: OpenCodeClient
  server: OpenCodeServer

}>

export type OpenCodeAdapterIdentity = {
  providerId: string
  providerName: string
  heldBackRepositoryFiles?: readonly string[]
}

type Session = {
  threadId: string
  cwd: string
  runtime: Runtime
  // The newest message id this session is known to hold. The next prompt's id
  // must sort after it.
  newestMessageId?: string
  // Changes each time the thread is loaded, so a reply that settles after an
  // unload cannot leave anything behind for the next load.
  generation: number
  activeTurnId?: string
  // Set once the server shows the active turn's own messages. The server ends
  // an aborted run before it takes the next prompt, so after an interrupt an
  // idle or error that comes before them is the interrupted turn's, not this
  // one's.
  activeTurnStarted?: true
  // The turn an interrupt was sent for, until the first idle after it (an
  // error before that idle is the same run's). Only an interrupt arms the wait
  // above; without one, the first idle or error ends the active turn as before.
  interruptedTurnId?: string
  assistantMessageTurnIds: Map<string, string>
  toolPhases: Map<string, string>
  // Set while the thread is being stopped because an approval was answered
  // elsewhere. Its events are still read until the provider confirms the stop.
  stopping?: true
}

type DirectoryStream = {
  controller: AbortController
  threadIds: Set<string>
}

type PendingApproval = {
  // The session that asked: the Domovoi thread itself, or a subagent session
  // the thread's task tool started. The reply goes to that session.
  providerSessionId: string
  cwd: string
  permissionId: string
  // Set when a subagent asked: the thread and turn the subagent belongs to.
  // Its approval ends with that turn.
  subagentTurn?: SubagentTurn
  generation?: number
  // Kilo ignores an approval of a skill shell batch or a sandbox escalation
  // unless the reply says a person gave it interactively, which the legacy
  // reply Domovoi sends cannot say. An approval of one is never Domovoi's.
  interactiveOnly?: true
}

type ProviderReply = "once" | "always" | "reject" | "unknown"

// A reply this adapter sent. It is recorded before it is sent, because the
// server publishes permission.replied before it answers the request that
// caused it, but it counts as Domovoi's only once the server has accepted it:
// the server takes one answer per request and refuses every later one, so the
// answer it accepted is the one its event reports. Until then it is an intent.
type SentReply = {
  response: "once" | "reject"
  // The Domovoi thread the asking session belongs to, so an unload forgets it.
  threadId: string
  providerSessionId: string
  permissionId: string
  state: "sending" | "accepted"
  // A matching reply event that arrived while the answer was being sent. It
  // is Domovoi's if the server accepts the answer, and someone else's if not.
  eventSeen?: true
}

type SubagentTurn = {
  threadId: string
  turnId: string
  // Set by the registry: distinguishes this link from a later link of a
  // reused session id.
  link?: number
}

// Subagent sessions, by session id. A linked subagent belongs to the thread
// and turn that started it, and keeps that turn after it ends so its late
// events are recognised. A subagent first seen while its thread had no active
// turn is never linked (owner ruling 2026-09-23) and stays ignored, as does
// anything it starts. A deleted session's record is dropped, and a bounded
// tombstone keeps it from being adopted again.
export class SubagentRegistry {
  readonly #linked = new Map<string, SubagentTurn>()
  readonly #neverLinked = new Map<string, string>()
  readonly #tombstones = new Map<string, string>()
  readonly #tombstoneLimit: number
  #nextLink = 0

  constructor(tombstoneLimit = 1_024) {
    this.#tombstoneLimit = tombstoneLimit
  }

  get size(): number {
    return this.#linked.size + this.#neverLinked.size
  }

  get tombstones(): number {
    return this.#tombstones.size
  }

  get(sessionId: string): SubagentTurn | undefined {
    return this.#linked.get(sessionId)
  }

  neverLinkedThread(sessionId: string): string | undefined {
    return this.#neverLinked.get(sessionId)
  }

  isKnown(sessionId: string): boolean {
    return this.#linked.has(sessionId) || this.#neverLinked.has(sessionId) || this.#tombstones.has(sessionId)
  }

  link(sessionId: string, turn: SubagentTurn): void {
    this.#linked.set(sessionId, { threadId: turn.threadId, turnId: turn.turnId, link: ++this.#nextLink })
  }

  neverLink(sessionId: string, threadId: string): void {
    this.#neverLinked.set(sessionId, threadId)
  }

  // A deletion seen before the creation is remembered too, so the creation
  // that follows adopts nothing.
  delete(sessionId: string, fallbackThreadId = ""): void {
    const threadId = this.#linked.get(sessionId)?.threadId
      ?? this.#neverLinked.get(sessionId)
      ?? (fallbackThreadId || this.#tombstones.get(sessionId))
      ?? fallbackThreadId
    this.#linked.delete(sessionId)
    this.#neverLinked.delete(sessionId)
    // Re-insert so a repeated deletion is the newest tombstone, not the oldest.
    this.#tombstones.delete(sessionId)
    this.#tombstones.set(sessionId, threadId)
    while (this.#tombstones.size > this.#tombstoneLimit) {
      const oldest = this.#tombstones.keys().next().value
      if (oldest === undefined) break
      this.#tombstones.delete(oldest)
    }
  }

  // Every subagent session known to belong to the thread, linked or not.
  sessionsOf(threadId: string): string[] {
    return [
      ...[...this.#linked].filter(([, owner]) => owner.threadId === threadId).map(([sessionId]) => sessionId),
      ...[...this.#neverLinked].filter(([, owner]) => owner === threadId).map(([sessionId]) => sessionId),
    ]
  }

  forgetThread(threadId: string): void {
    for (const [sessionId, owner] of this.#linked) if (owner.threadId === threadId) this.#linked.delete(sessionId)
    for (const [sessionId, owner] of this.#neverLinked) if (owner === threadId) this.#neverLinked.delete(sessionId)
    for (const [sessionId, owner] of this.#tombstones) if (owner === threadId) this.#tombstones.delete(sessionId)
  }
}

type PendingSessionLoad = {
  cwd: string
  cancelled: boolean
}

// OpenCode and Kilo refuse a message id that does not start with "msg" and
// order a session's messages by id. This is their ascending scheme: "msg_",
// the low 48 bits of milliseconds times 4096 plus a per-millisecond counter as
// twelve hex digits, then fourteen random base62 characters.
const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const orderMask = 0xffff_ffff_ffffn
const orderedMessageId = /^msg_([0-9a-f]{12})/u
let lastOrder = 0n
const historyPageSize = 200
const maximumHistoryPages = 1_000

export function openCodeMessageOrder(milliseconds: number, counter = 1): string {
  return ((BigInt(milliseconds) * 0x1000n + BigInt(counter)) & orderMask).toString(16).padStart(12, "0")
}

// The session already holds an id at the last order the servers can store,
// so no id can sort after it.
export class OpenCodeMessageIdsExhaustedError extends Error {
  constructor() {
    super("No message id sorts after the session's newest one")
    this.name = "OpenCodeMessageIdsExhaustedError"
  }
}

// Each id sorts after the last one this process made, even when the clock
// steps back or a millisecond runs out of counter values, and after `after`,
// the newest id the session is known to hold. Past the 48-bit order an id is
// refused rather than masked, because a masked id wraps to zero and sorts
// first. The process-wide order follows the clock only; a session's floor
// raises that session's id, never every other session's.
export function openCodeMessageId(now = Date.now(), after?: string): string {
  const clock = BigInt(`0x${openCodeMessageOrder(now)}`)
  let order = clock > lastOrder ? clock : lastOrder + 1n
  // The servers' own ids wrap here too (about every 795 days); follow the clock.
  if (order > orderMask) order = clock
  lastOrder = order
  const floor = after === undefined ? undefined : orderedMessageId.exec(after)?.[1]
  if (floor !== undefined && order <= BigInt(`0x${floor}`)) order = BigInt(`0x${floor}`) + 1n
  if (order > orderMask) throw new OpenCodeMessageIdsExhaustedError()
  const random = Array.from(randomBytes(14), (byte) => base62[byte % 62]).join("")
  return `msg_${order.toString(16).padStart(12, "0")}${random}`
}

export function nextOpenCodeMessageId(after?: string): string {
  return openCodeMessageId(Date.now(), after)
}

function laterMessageId(current: string | undefined, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || !orderedMessageId.test(candidate)) return current
  return current === undefined || candidate > current ? candidate : current
}

export function openCodeAgentFor(runtime: Runtime): string {
  if (runtime.permissionMode === "ask") return "domovoi-ask"
  if (runtime.permissionMode === "plan") return "plan"
  if (runtime.permissionMode === "build" && runtime.auto) return "domovoi-auto"
  return "build"
}

export class OpenCodeSdkAdapter implements AgentAdapter {
  readonly permissionCapabilities = { ask: "read-only", buildAuto: "pre-execution" } as const
  readonly #factory: OpenCodeFactory
  readonly #id: (after?: string) => string
  readonly #identity: OpenCodeAdapterIdentity
  #runtime: Awaited<ReturnType<OpenCodeFactory>> | undefined
  #connection: Promise<void> | undefined
  #closed = false
  #sessions = new Map<string, Session>()
  #pendingSessionLoads = new Map<string, PendingSessionLoad>()
  #directories = new Map<string, DirectoryStream>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #subagents = new SubagentRegistry()
  // Refusals the provider did not accept, by request id. They are sent again
  // when the card is answered or the thread's next turn starts or ends.
  #failedRefusals = new Map<number, PendingApproval>()
  // Replies this adapter sent, by asking session and request (replyKey). The
  // embedded server's password is in its startup environment, which every
  // program the server starts can read as the same user, and nothing in a
  // reply says who sent it; these records are how a reply is known as ours.
  #sentReplies = new Map<string, SentReply>()
  // A rejection the server takes rejects every other request of the same
  // session that is waiting then (opencode permission/index.ts:129-138, kilo
  // :322-331). The requests Domovoi knew to be waiting when it sent one, by
  // replyKey, with the rejection that covers them (origin) and their thread.
  // A rejection of one of them is the server's; it refuses nothing more. They
  // are dropped when the rejection does not go through and when the turn ends
  // (Codex review of #691, P3).
  #cascadeRejections = new Map<string, { origin: string; threadId: string }>()
  // A server Domovoi stopped and has not confirmed gone, kept so it can be
  // stopped again, and the stop under way. While either is set, no other
  // server starts (Codex review of #691, round 2).
  #retiredServer: OpenCodeServer | undefined
  #retiring: Promise<void> | undefined
  #nextApprovalId = 0
  #nextGeneration = 0

  constructor(
    factory: OpenCodeFactory = defaultOpenCodeFactory,
    id: (after?: string) => string = nextOpenCodeMessageId,
    identity: OpenCodeAdapterIdentity = { providerId: "opencode", providerName: "OpenCode" },
  ) {
    this.#factory = factory
    this.#id = id
    this.#identity = identity
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error(`${this.#identity.providerName} adapter closed`)
    if (this.#runtime) return
    // A stopped server not yet confirmed gone blocks the next one (Codex
    // review of #691, round 2): it is stopped again, and while it may still
    // run, with the password and the programs it started, none other starts.
    const retired = this.#retiredServer
    if (retired) {
      await this.#retire(retired)
      if (this.#retiredServer) throw new PublicRpcError(invalidParams, this.#retiredServerRefusal(retired))
    }
    this.#connection ??= this.#factory().then((runtime) => {
      if (this.#closed) runtime.server.close()
      else this.#runtime = runtime
    })
    const connection = this.#connection
    try {
      await connection
      if (this.#closed) throw new Error(`${this.#identity.providerName} adapter closed`)
    } finally {
      if (this.#connection === connection) this.#connection = undefined
    }
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    signal?.throwIfAborted()
    const client = await this.#client()
    signal?.throwIfAborted()
    const [config, catalog] = await Promise.all([
      client.config.get({ throwOnError: true, ...(signal ? { signal } : {}) }),
      client.config.providers({ throwOnError: true, ...(signal ? { signal } : {}) }),
    ])
    const configured = requireConfig(
      unwrap(config, `${this.#identity.providerName} config`),
      `${this.#identity.providerName} config`,
    )
    const providerCatalog = requireCatalog(
      unwrap(catalog, `${this.#identity.providerName} provider catalog`),
      `${this.#identity.providerName} provider catalog`,
    )
    const models = providerCatalog.providers
      .flatMap((provider) => Object.values(provider.models).map((model) => ({ provider, model })))
      .filter(({ model }) => model.status !== "deprecated")
      .sort((left, right) =>
        left.provider.name.localeCompare(right.provider.name)
        || left.model.name.localeCompare(right.model.name),
      )
    const defaultModel = configured.model
      ?? models.map(({ provider, model }) => ({
        id: `${provider.id}/${model.id}`,
        isProviderDefault: providerCatalog.default[provider.id] === model.id,
      })).find((candidate) => candidate.isProviderDefault)?.id
      ?? (models[0] ? `${models[0].provider.id}/${models[0].model.id}` : undefined)

    return models.map(({ provider, model }) => {
      const id = `${provider.id}/${model.id}`
      const reasoning = model.capabilities?.reasoning === true ? "medium" : "none"
      return {
        provider: this.#identity.providerId,
        id,
        displayName: `${provider.name} / ${model.name}`,
        description: `${this.#identity.providerName} model from ${provider.name}`,
        supportedReasoningEfforts: [reasoning],
        defaultReasoningEffort: reasoning,
        isDefault: id === defaultModel,
      }
    })
  }

  async startThread({ cwd, runtime }: { cwd: string; runtime: Runtime }): Promise<string> {
    await this.#refuseHeldBackRepositoryFiles(cwd)
    const client = await this.#client()
    const action = `${this.#identity.providerName} session creation`
    const created = requireSession(
      unwrap(await client.session.create({
        query: { directory: cwd },
        body: { title: "Domovoi session" },
        throwOnError: true,
      }), action),
      action,
    )
    try {
      await this.#loadSession(created.id, cwd, runtime)
    } catch (error) {
      try {
        await client.session.delete({
          path: { id: created.id },
          query: { directory: cwd },
          throwOnError: true,
        })
      } catch (cleanupError) {
        console.error(`Domovoi could not remove a failed ${this.#identity.providerName} session`, cleanupError)
      }
      throw error
    }
    return created.id
  }

  async resumeThread({ threadId, cwd, runtime }: {
    threadId: string
    cwd: string
    runtime: Runtime
  }): Promise<void> {
    if (this.#sessions.has(threadId)) return
    await this.#refuseHeldBackRepositoryFiles(cwd)
    const pending = { cwd, cancelled: false }
    this.#pendingSessionLoads.set(threadId, pending)
    try {
      const client = await this.#client()
      const action = `${this.#identity.providerName} session resume`
      const session = requireSession(
        unwrap(await client.session.get({
          path: { id: threadId },
          query: { directory: cwd },
          throwOnError: true,
        }), action),
        action,
      )
      if (session.id !== threadId) {
        throw new Error(`${this.#identity.providerName} did not resume the requested session`)
      }
      // Listen first, then read the history: a message another client creates
      // while the pages are read still raises the high-water mark.
      await this.#loadSession(threadId, cwd, runtime, pending)
      try {
        const greatest = await this.#greatestMessageId(client, threadId, cwd)
        const loaded = this.#sessions.get(threadId)
        if (pending.cancelled || !loaded) {
          throw new Error(`${this.#identity.providerName} session stopped while resuming`)
        }
        const newest = laterMessageId(loaded.newestMessageId, greatest)
        if (newest !== undefined) loaded.newestMessageId = newest
      } catch (error) {
        const loaded = this.#sessions.get(threadId)
        if (loaded) this.#unloadSession(loaded)
        throw error
      }
    } finally {
      if (this.#pendingSessionLoads.get(threadId) === pending) {
        this.#pendingSessionLoads.delete(threadId)
      }
    }
  }

  async startTurn({ threadId, prompt, runtime }: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string> {
    const session = this.#requireSession(threadId)
    this.#retryFailedRefusals(threadId)
    const turnId = this.#nextMessageId(session)
    session.runtime = runtime
    session.activeTurnId = turnId
    delete session.activeTurnStarted
    try {
      await this.#sendPrompt(session, turnId, prompt, runtime)
    } catch (error) {
      delete session.activeTurnId
      throw error
    }
    return turnId
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<{ providerMessageId: string }> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) {
      throw new Error(`${this.#identity.providerName} turn is no longer active`)
    }
    const providerMessageId = this.#nextMessageId(session)
    await this.#sendPrompt(session, providerMessageId, prompt, session.runtime)
    return { providerMessageId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) return
    const client = await this.#client()
    // Armed before the abort is sent, because the run's end can arrive before
    // the abort's own answer.
    session.interruptedTurnId = turnId
    try {
      unwrap(await client.session.abort({
        path: { id: threadId },
        query: { directory: session.cwd },
        throwOnError: true,
      }), `${this.#identity.providerName} turn interruption`)
    } catch (error) {
      if (session.interruptedTurnId === turnId) delete session.interruptedTurnId
      throw error
    }
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId)
    const pending = this.#pendingSessionLoads.get(threadId)
    if (!session && !pending) return
    if (pending) pending.cancelled = true
    const cwd = session?.cwd ?? pending!.cwd
    const client = await this.#client()
    if (session?.activeTurnId) {
      unwrap(await client.session.abort({
        path: { id: threadId },
        query: { directory: cwd },
        throwOnError: true,
      }), `${this.#identity.providerName} session interruption`)
    }
    unwrap(await client.session.delete({
      path: { id: threadId },
      query: { directory: cwd },
      throwOnError: true,
    }), `${this.#identity.providerName} session deletion`)
    if (session) this.#unloadSession(session)
  }

  resolveApproval(requestId: number, decision: ApprovalDecision): void {
    const failed = this.#failedRefusals.get(requestId)
    if (failed) {
      this.#failedRefusals.delete(requestId)
      this.#respond(failed, "reject", requestId)
      return
    }
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) return
    this.#pendingApprovals.delete(requestId)
    this.#respond(pending, decision === "allow-once" || decision === "always-project" ? "once" : "reject", requestId)
  }

  #respond(pending: PendingApproval, response: "once" | "reject", requestId: number): void {
    // Recorded before anything is sent, synchronously: the reply event this
    // causes can arrive before the request that caused it is answered.
    const threadId = pending.subagentTurn?.threadId ?? this.#subagents.neverLinkedThread(pending.providerSessionId)
      ?? pending.providerSessionId
    const key = replyKey(pending.providerSessionId, pending.permissionId)
    const record: SentReply = {
      response,
      threadId,
      providerSessionId: pending.providerSessionId,
      permissionId: pending.permissionId,
      state: "sending",
    }
    // An approval the server ignores is not recorded, so none it reports is ours.
    if (!pending.interactiveOnly || response === "reject") this.#sentReplies.set(key, record)
    else this.#sentReplies.delete(key)
    if (response === "reject") {
      for (const waiting of this.#pendingApprovals.values()) {
        if (waiting.providerSessionId !== pending.providerSessionId || waiting.permissionId === pending.permissionId) continue
        this.#cascadeRejections.set(replyKey(waiting.providerSessionId, waiting.permissionId), { origin: key, threadId })
      }
    }
    void this.#client().then(async (client) => {
      // Bounded (Codex review of #691, round 2): an answer with no outcome
      // after the bound is an unknown outcome, the same as a failed one.
      unwrap(await settlesWithin(
        client.postSessionIdPermissionsPermissionId({
          path: { id: pending.providerSessionId, permissionID: pending.permissionId },
          query: { directory: pending.cwd },
          body: { response },
          throwOnError: true,
        }),
        permissionAnswerConfirmMs,
        `${this.#identity.providerName} did not answer a permission response within ${permissionAnswerConfirmMs} ms`,
      ), `${this.#identity.providerName} permission response`)
    }).then(() => this.#replyAccepted(key, record), (error: unknown) => {
      console.error(`Domovoi could not resolve a ${this.#identity.providerName} permission`, error)
      this.#replyFailed(key, record)
      // A subagent's refusal must not be lost, or the subagent waits on it.
      const owner = pending.subagentTurn ? this.#sessions.get(pending.subagentTurn.threadId) : undefined
      const stillLoaded = owner !== undefined && owner.generation === pending.generation
      // A deleted subagent cannot take the refusal either, so nothing is kept for it.
      const stillLinked = this.#subagents.get(pending.providerSessionId)?.link === pending.subagentTurn?.link
      if (response === "reject" && pending.subagentTurn && stillLoaded && stillLinked && !this.#closed) {
        this.#failedRefusals.set(requestId, pending)
      }
    })
  }

  // The server accepted the answer, so the reply it reports for this request
  // is Domovoi's: one that already arrived is settled, a later one will be.
  #replyAccepted(key: string, record: SentReply): void {
    if (this.#sentReplies.get(key) !== record) return
    if (record.eventSeen) this.#sentReplies.delete(key)
    else record.state = "accepted"
  }

  // The answer did not go through, or nothing says whether it did. The record
  // is dropped, so a later reply for the request counts as someone else's,
  // and one that already arrived was someone else's.
  #replyFailed(key: string, record: SentReply): void {
    // A rejection the server did not take rejected nothing else either.
    for (const [covered, cascade] of this.#cascadeRejections) {
      if (cascade.origin === key) this.#cascadeRejections.delete(covered)
    }
    if (this.#sentReplies.get(key) !== record) return
    this.#sentReplies.delete(key)
    if (!record.eventSeen) return
    const session = this.#sessions.get(record.threadId)
    if (session) this.#stopForReplyElsewhere(session, record.providerSessionId, record.permissionId, record.response)
  }

  #retryFailedRefusals(threadId: string): void {
    for (const [requestId, pending] of this.#failedRefusals) {
      if (pending.subagentTurn?.threadId !== threadId) continue
      this.#failedRefusals.delete(requestId)
      this.#respond(pending, "reject", requestId)
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const directory of this.#directories.values()) directory.controller.abort()
    this.#directories.clear()
    this.#sessions.clear()
    this.#subagents = new SubagentRegistry()
    this.#pendingApprovals.clear()
    this.#failedRefusals.clear()
    this.#sentReplies.clear()
    this.#cascadeRejections.clear()
    this.#runtime?.server.close()
    this.#runtime = undefined
    this.#retiredServer?.close()
    await this.#connection
  }

  async #refuseHeldBackRepositoryFiles(cwd: string): Promise<void> {
    for (const file of this.#identity.heldBackRepositoryFiles ?? []) {
      try {
        await lstat(join(cwd, file))
      } catch {
        continue
      }
      throw new Error(
        `${this.#identity.providerName} would load ${file} from this worktree, and that file can start programs or change agent permissions. `
        + "Domovoi does not load repository-brought configuration until a trust gate ships. "
        + `Remove ${file} from this worktree or use another provider here.`,
      )
    }
  }

  // The servers page a session newest-first by creation time, and a clock that
  // stepped back can leave an older message with a greater id, so the whole
  // history is read for its greatest id.
  // A repeated cursor means the pages cannot be trusted to cover the history,
  // so the resume is refused. A full page with no cursor may be a server that
  // does not page; the whole history is then read in one request.
  async #greatestMessageId(client: OpenCodeClient, threadId: string, cwd: string): Promise<string | undefined> {
    let greatest: string | undefined
    let before: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < maximumHistoryPages; page += 1) {
      const result = await client.session.messages({
        path: { id: threadId },
        query: { directory: cwd, limit: historyPageSize, ...(before === undefined ? {} : { before }) },
        throwOnError: true,
      })
      const messages = this.#historyMessages(result)
      for (const message of messages) greatest = laterMessageId(greatest, asRecord(asRecord(message)?.info)?.id)
      const next = result.response?.headers.get("x-next-cursor") ?? undefined
      if (!next) {
        if (messages.length < historyPageSize) return greatest
        return this.#greatestInWholeHistory(client, threadId, cwd, greatest)
      }
      if (seenCursors.has(next)) {
        throw new Error(`${this.#identity.providerName} session history repeated a page, so it cannot be resumed`)
      }
      seenCursors.add(next)
      before = next
    }
    throw new Error(`${this.#identity.providerName} session history is too long to resume`)
  }

  async #greatestInWholeHistory(
    client: OpenCodeClient,
    threadId: string,
    cwd: string,
    greatest: string | undefined,
  ): Promise<string | undefined> {
    const result = await client.session.messages({
      path: { id: threadId },
      query: { directory: cwd },
      throwOnError: true,
    })
    let whole = greatest
    for (const message of this.#historyMessages(result)) whole = laterMessageId(whole, asRecord(asRecord(message)?.info)?.id)
    return whole
  }

  #historyMessages(result: OpenCodeResult<unknown>): unknown[] {
    const messages = unwrap(result, `${this.#identity.providerName} session history`)
    return Array.isArray(messages) ? messages : []
  }

  #nextMessageId(session: Session): string {
    let id: string
    try {
      id = this.#id(session.newestMessageId)
    } catch (error) {
      if (!(error instanceof OpenCodeMessageIdsExhaustedError)) throw error
      throw new Error(`${this.#identity.providerName} session has used the last message id the server can order, so it cannot take another message`, { cause: error })
    }
    const newest = laterMessageId(session.newestMessageId, id)
    if (newest !== undefined) session.newestMessageId = newest
    return id
  }

  async #client(): Promise<OpenCodeClient> {
    await this.connect()
    return this.#runtime!.client
  }

  async #loadSession(
    threadId: string,
    cwd: string,
    runtime: Runtime,
    pending?: PendingSessionLoad,
  ): Promise<void> {
    const session: Session = {
      threadId,
      cwd,
      runtime,
      generation: ++this.#nextGeneration,
      assistantMessageTurnIds: new Map(),
      toolPhases: new Map(),
    }
    const existing = this.#directories.get(cwd)
    if (existing) {
      if (pending?.cancelled) {
        throw new Error(`${this.#identity.providerName} session stopped while resuming`)
      }
      this.#sessions.set(threadId, session)
      existing.threadIds.add(threadId)
      return
    }
    const controller = new AbortController()
    const client = await this.#client()
    const events = requireEventSubscription(
      await client.event.subscribe({
        query: { directory: cwd },
        signal: controller.signal,
      }),
      `${this.#identity.providerName} event subscription`,
    )
    if (pending?.cancelled) {
      controller.abort()
      throw new Error(`${this.#identity.providerName} session stopped while resuming`)
    }
    this.#directories.set(cwd, { controller, threadIds: new Set([threadId]) })
    this.#sessions.set(threadId, session)
    void this.#consume(cwd, events.stream).then(
      () => this.#disconnect(cwd, controller, `${this.#identity.providerName} event stream connection closed`),
      (error: unknown) => this.#disconnect(
        cwd,
        controller,
        error instanceof Error ? error.message : `${this.#identity.providerName} event stream failed`,
      ),
    )
  }

  // Without its event stream a directory's runs cannot be watched: a reply
  // made elsewhere would go unseen. Their pending requests are refused and
  // their runs aborted before they are let go, and a run the provider does
  // not confirm stopped ends the whole server (Codex review of #691, P1).
  #disconnect(cwd: string, controller: AbortController, reason: string): void {
    if (controller.signal.aborted) return
    controller.abort()
    this.#directories.delete(cwd)
    const sessions = [...this.#sessions.values()].filter((session) => session.cwd === cwd)
    for (const session of sessions) this.#refusePendingFor(session.threadId)
    void Promise.all(sessions.map((session) => this.#abortThread(session))).then(async (confirmed) => {
      if (!confirmed.every(Boolean)) {
        await this.#stopServer(this.#unconfirmedStopReason())
        return
      }
      for (const session of sessions) {
        if (this.#sessions.get(session.threadId) !== session) continue
        this.#complete(session, "failed", reason)
        this.#forgetSubagents(session.threadId)
        this.#forgetReplies(session.threadId)
        this.#sessions.delete(session.threadId)
      }
      this.#emit({ type: "provider-disconnected", reason })
    })
  }

  // An unloaded thread hears no more replies, so what was recorded for its
  // sessions is dropped.
  #forgetReplies(threadId: string): void {
    for (const [key, sent] of this.#sentReplies) if (sent.threadId === threadId) this.#sentReplies.delete(key)
    this.#forgetCascadeRejections(threadId)
  }

  #forgetCascadeRejections(threadId: string): void {
    for (const [key, cascade] of this.#cascadeRejections) {
      if (cascade.threadId === threadId) this.#cascadeRejections.delete(key)
    }
  }

  #forgetSubagents(threadId: string): void {
    this.#subagents.forgetThread(threadId)
    for (const [requestId, pending] of this.#failedRefusals) {
      if (pending.subagentTurn?.threadId === threadId) this.#failedRefusals.delete(requestId)
    }
  }

  // An unloaded thread's approvals cannot be answered any more: refuse what is
  // still pending on the provider and forget it, so a later card answer sends
  // nothing to a session that is gone.
  #refusePendingFor(threadId: string): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.providerSessionId !== threadId && pending.subagentTurn?.threadId !== threadId) continue
      this.#pendingApprovals.delete(requestId)
      this.#respond(pending, "reject", requestId)
    }
  }

  // A deleted provider session cannot take an answer: drop what waits on it.
  #forgetProviderSession(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.providerSessionId === sessionId) this.#pendingApprovals.delete(requestId)
    }
    for (const [requestId, pending] of this.#failedRefusals) {
      if (pending.providerSessionId === sessionId) this.#failedRefusals.delete(requestId)
    }
  }

  #unloadSession(session: Session): void {
    this.#refusePendingFor(session.threadId)
    this.#forgetSubagents(session.threadId)
    this.#forgetReplies(session.threadId)
    this.#sessions.delete(session.threadId)
    const directory = this.#directories.get(session.cwd)
    if (!directory) return
    directory.threadIds.delete(session.threadId)
    if (directory.threadIds.size > 0) return
    directory.controller.abort()
    this.#directories.delete(session.cwd)
  }

  async #sendPrompt(
    session: Session,
    messageId: string,
    prompt: string,
    runtime: Runtime,
  ): Promise<void> {
    await this.#refuseHeldBackRepositoryFiles(session.cwd)
    const client = await this.#client()
    const model = openCodeModel(runtime.model)
    const system = await projectInstructions(session.cwd, "opencode")
    ensureSuccess(await client.session.promptAsync({
      path: { id: session.threadId },
      query: { directory: session.cwd },
      body: {
        messageID: messageId,
        agent: openCodeAgentFor(runtime),
        ...(model ? { model } : {}),
        ...(system ? { system } : {}),
        parts: [{ type: "text", text: prompt }],
      },
      throwOnError: true,
    }), `${this.#identity.providerName} prompt`)
  }

  async #consume(cwd: string, stream: AsyncIterable<OpenCodeEvent>): Promise<void> {
    for await (const event of stream) this.#receive(cwd, event)
  }

  // A subagent the task tool starts runs as its own session, with its own
  // tools and approvals, in the same directory. Its session records its parent.
  #adoptSubagent(cwd: string, properties: Record<string, unknown>): void {
    const info = asRecord(properties.info)
    if (typeof info?.id !== "string" || typeof info.parentID !== "string") return
    if (this.#sessions.has(info.id) || this.#subagents.isKnown(info.id)) return
    const parentSubagent = this.#subagents.get(info.parentID)
    const parentNeverLinked = this.#subagents.neverLinkedThread(info.parentID)
    const threadId = parentSubagent?.threadId ?? parentNeverLinked ?? info.parentID
    const session = this.#sessions.get(threadId)
    if (session?.cwd !== cwd) return
    if (parentNeverLinked !== undefined) {
      this.#subagents.neverLink(info.id, threadId)
      return
    }
    // A subagent's own subagent belongs to the same turn, even one that ended.
    if (parentSubagent) {
      this.#subagents.link(info.id, parentSubagent)
      return
    }
    if (!session.activeTurnId) {
      this.#subagents.neverLink(info.id, threadId)
      return
    }
    this.#subagents.link(info.id, { threadId, turnId: session.activeTurnId })
  }

  #receive(cwd: string, event: OpenCodeEvent): void {
    // Kilo also streams events with no properties at all, such as `sync`.
    const properties = asRecord(event.properties)
    if (!properties) return
    // Only session.created adopts an unknown session: a session.updated for an
    // id nothing remembers (a deleted one whose tombstone aged out) is stale.
    if (event.type === "session.created") this.#adoptSubagent(cwd, properties)
    if (event.type === "session.deleted") {
      const deleted = asRecord(properties.info)?.id
      if (typeof deleted !== "string") return
      const root = this.#sessions.get(deleted)
      if (root && root.cwd === cwd) {
        // The provider removed the thread itself; nothing can be sent to it.
        this.#complete(root, "failed", `${this.#identity.providerName} deleted the session`)
        this.#forgetProviderSession(deleted)
        this.#unloadSession(root)
        return
      }
      this.#forgetProviderSession(deleted)
      const parent = asRecord(properties.info)?.parentID
      this.#subagents.delete(deleted, typeof parent === "string" ? parent : "")
      return
    }
    const sessionId = eventSessionId(properties)
    if (!sessionId) return
    // permission.v2.replied has the current reply's shape (opencode
    // schema/src/permission.ts:44-51). Domovoi sends no v2 reply, so every one
    // is someone else's (Codex review of #691, P2).
    if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
      this.#receiveReply(cwd, sessionId, properties)
      return
    }
    if (event.type === "permission.v2.asked") {
      this.#refuseUnanswerable(cwd, sessionId)
      return
    }
    const subagentTurn = this.#subagents.get(sessionId)
    const subagent = subagentTurn !== undefined
    const session = this.#sessions.get(subagentTurn?.threadId ?? sessionId)
    if (!session || session.cwd !== cwd) return
    // A subagent outlives nothing: once the turn that started it has ended,
    // whatever it still sends is dropped rather than attached to a later turn,
    // and an approval it asks for is refused at once, with no card.
    if (subagentTurn && session.activeTurnId !== subagentTurn.turnId) {
      if (event.type !== "permission.updated" && event.type !== "permission.asked") return
      const request = permissionRequest(event.type, properties, this.#identity.providerName)
      if (request) {
        this.#respond(
          { providerSessionId: sessionId, cwd, permissionId: request.permissionId, subagentTurn, generation: session.generation },
          "reject",
          ++this.#nextApprovalId,
        )
      }
      return
    }

    if (event.type === "message.updated") {
      const info = asRecord(properties.info)
      if (session.activeTurnId !== undefined && (info?.id === session.activeTurnId || info?.parentID === session.activeTurnId)) {
        session.activeTurnStarted = true
      }
      const newest = laterMessageId(session.newestMessageId, info?.id)
      if (newest !== undefined) session.newestMessageId = newest
      if (info?.role === "assistant" && typeof info.id === "string") {
        const turnId = subagentTurn
          ? subagentTurn.turnId
          : typeof info.parentID === "string" ? info.parentID : undefined
        if (!turnId) return
        session.assistantMessageTurnIds.set(info.id, turnId)
        const tokens = asRecord(info.tokens)
        const cache = asRecord(tokens?.cache)
        const hasTokens = [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.total, cache?.read, cache?.write]
          .some((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        const source = {
          kind: "message" as const,
          id: info.id,
          tokens: hasTokens ? "reported" as const : "unavailable" as const,
          final: typeof asRecord(info.time)?.completed === "number",
          ...(typeof info.providerID === "string" && typeof info.modelID === "string"
            ? { model: `${info.providerID}/${info.modelID}` } : {}),
        }
        const unavailable = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          reasoningTokens: 0, totalTokens: 0, costSource: "unavailable" as const }
        try {
          const usage = normalizeProviderUsage(info) ?? unavailable
          this.#emit({ type: "usage", threadId: session.threadId, turnId, usage, source })
        } catch {
          this.#emit({
            type: "usage", threadId: session.threadId, turnId,
            usage: unavailable,
            source: { ...source, tokens: "unavailable", invalid: true },
          })
        }
      }
      return
    }
    const turnId = session.activeTurnId
    if (!turnId) return
    if (event.type === "message.part.updated") {
      const part = asRecord(properties.part)
      if (
        typeof part?.messageID !== "string"
        || !session.assistantMessageTurnIds.has(part.messageID)
      ) return
      const parentTurnId = session.assistantMessageTurnIds.get(part.messageID)!
      if (!subagent && part?.type === "text" && typeof properties.delta === "string") {
        this.#emit({ type: "text-delta", threadId: session.threadId, turnId: parentTurnId, delta: properties.delta })
      }
      if (part?.type === "tool") this.#receiveTool(session, parentTurnId, part)
      return
    }
    if (event.type === "permission.updated" || event.type === "permission.asked") {
      const request = permissionRequest(event.type, properties, this.#identity.providerName)
      if (!request) return
      const requestId = ++this.#nextApprovalId
      this.#pendingApprovals.set(requestId, {
        providerSessionId: sessionId,
        cwd,
        permissionId: request.permissionId,
        ...(subagentTurn ? { subagentTurn, generation: session.generation } : {}),
        ...(interactiveOnly(properties) ? { interactiveOnly: true as const } : {}),
      })
      this.#emit({
        type: "approval-requested",
        requestId,
        threadId: session.threadId,
        turnId,
        ...(request.itemId ? { itemId: request.itemId } : {}),
        command: request.command,
        cwd,
        ...(request.path ? { path: request.path } : {}),
        ...(request.tool !== undefined ? { tool: request.tool } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      })
      return
    }
    // A subagent finishing or failing ends its task tool call, not the turn.
    if (subagent) return
    if (event.type === "session.error" || event.type === "session.idle") {
      const interrupted = session.interruptedTurnId
      // An interrupted run can end with an error and then an idle (the
      // processor's halt publishes both), so the record lasts until the idle.
      if (event.type === "session.idle") delete session.interruptedTurnId
      // The interrupted run's own end, arriving after the next turn took the
      // slot and before that turn's messages. It ends nothing.
      if (interrupted !== undefined && session.activeTurnId !== interrupted && !session.activeTurnStarted) return
    }
    if (event.type === "session.error") {
      const error = asRecord(properties.error)
      const interrupted = session.interruptedTurnId
      this.#complete(session, "failed", errorMessage(error, this.#identity.providerName))
      // The error can end the interrupted turn itself. Its idle is still to
      // come, so the record stays until that idle.
      if (interrupted !== undefined) session.interruptedTurnId = interrupted
      return
    }
    if (event.type === "session.idle") this.#complete(session, "completed")
  }

  // `requestID` and `reply` are what current servers send (opencode 1.18,
  // kilo 7.8); `permissionID` and `response` are the older shape. A reply is
  // this adapter's only when it sent that same reply for that request and the
  // server accepted it (Q246 A, Codex review of #691), or when it is a
  // rejection the server added for a session this adapter had sent a
  // rejection to. A matching reply that arrives while the answer is still
  // being sent waits for the server's answer. Anything else stops the thread
  // the asking session belongs to (Q247 A), including a reply that names no
  // request: nothing in it says it was this adapter's.
  #receiveReply(cwd: string, sessionId: string, properties: Record<string, unknown>): void {
    const threadId = this.#subagents.get(sessionId)?.threadId
      ?? this.#subagents.neverLinkedThread(sessionId)
      ?? sessionId
    const session = this.#sessions.get(threadId)
    if (!session || session.cwd !== cwd) return
    const requestId = typeof properties.requestID === "string"
      ? properties.requestID
      : typeof properties.permissionID === "string" ? properties.permissionID : ""
    const value = properties.reply ?? properties.response
    const reply: ProviderReply = value === "once" || value === "always" || value === "reject" ? value : "unknown"
    const key = replyKey(sessionId, requestId)
    const sent = requestId ? this.#sentReplies.get(key) : undefined
    // Checked first: Domovoi's own rejection of a request the server has just
    // rejected for it is then refused, and that refusal must not stop the thread.
    if (reply === "reject" && this.#cascadeRejections.delete(key)) {
      this.#sentReplies.delete(key)
      return
    }
    if (sent?.response === reply) {
      if (sent.state === "accepted") this.#sentReplies.delete(key)
      else sent.eventSeen = true
      return
    }
    this.#stopForReplyElsewhere(session, sessionId, requestId, reply)
  }

  // The request was already answered, so it is dropped without a reply, and
  // every other request the thread holds is refused at once. The thread's
  // run and its subagents' runs are aborted, and the thread stays watched
  // until the provider confirms each abort (Codex review of #691, P1). Then the
  // turn fails with its own failure, the thread is unloaded and the daemon is
  // told, after the turn's end, so it can record why the session stopped. A
  // stop the provider does not confirm ends the whole server.
  #stopForReplyElsewhere(session: Session, sessionId: string, requestId: string, reply: ProviderReply): void {
    if (session.stopping) return
    session.stopping = true
    const turnId = session.activeTurnId
    for (const waiting of [this.#pendingApprovals, this.#failedRefusals]) {
      for (const [id, pending] of waiting) {
        if (pending.providerSessionId === sessionId && pending.permissionId === requestId) waiting.delete(id)
      }
    }
    this.#refusePendingFor(session.threadId)
    void this.#abortThread(session, sessionId).then(async (confirmed) => {
      if (this.#sessions.get(session.threadId) === session) {
        this.#complete(session, "failed", approvalAnsweredElsewhere.message, approvalAnsweredElsewhere)
        this.#unloadSession(session)
      }
      this.#emit({
        type: "approval-answered-elsewhere",
        threadId: session.threadId,
        ...(turnId ? { turnId } : {}),
        permissionId: requestId,
        reply,
      })
      // Always restarted (Codex review of #691, P1): an always reply leaves an
      // allow rule in the server's memory for the whole directory, opencode
      // permission/index.ts:145-151, kilo :342-351. OpenCode keeps no such
      // rule anywhere else; what Kilo writes to its global configuration is
      // beyond a restart (see the daemon README).
      const name = this.#identity.providerName
      await this.#stopServer(confirmed
        ? `Domovoi restarted the ${name} server because an approval was answered outside Domovoi, so no approval it kept stays in place`
        : this.#unconfirmedStopReason())
    })
  }

  // A v2 permission request is answered through an interface Domovoi does not
  // use, so it cannot be shown or answered. Its run is aborted and the turn
  // ends, rather than wait for an answer that could only come from elsewhere.
  #refuseUnanswerable(cwd: string, sessionId: string): void {
    const threadId = this.#subagents.get(sessionId)?.threadId
      ?? this.#subagents.neverLinkedThread(sessionId)
      ?? sessionId
    const session = this.#sessions.get(threadId)
    if (!session || session.cwd !== cwd || session.stopping) return
    const name = this.#identity.providerName
    void this.#abortThread(session, sessionId).then(async (confirmed) => {
      if (!confirmed) {
        await this.#stopServer(this.#unconfirmedStopReason())
        return
      }
      if (this.#sessions.get(session.threadId) !== session) return
      this.#complete(
        session,
        "failed",
        `${name} asked for an approval through a permission interface Domovoi does not answer, so Domovoi stopped the turn`,
      )
    })
  }

  // Aborts the thread's run and every subagent run it is known to have, and
  // resolves true only when the provider confirmed each abort in time.
  async #abortThread(session: Session, ...more: string[]): Promise<boolean> {
    const runtime = this.#runtime
    if (!runtime) return false
    const ids = new Set([session.threadId, ...more, ...this.#subagents.sessionsOf(session.threadId)])
    const results = await Promise.allSettled([...ids].map((id) => settlesWithin(
      runtime.client.session.abort({
        path: { id },
        query: { directory: session.cwd },
        throwOnError: true,
      }).then((result) => unwrap(result, `${this.#identity.providerName} session stop`)),
      abortConfirmMs,
      `${this.#identity.providerName} did not confirm the stop within ${abortConfirmMs} ms`,
    )))
    const failed = results.filter((result) => result.status === "rejected")
    for (const failure of failed) {
      console.error(`Domovoi could not confirm a ${this.#identity.providerName} session stopped`, failure.reason)
    }
    return failed.length === 0
  }

  #unconfirmedStopReason(): string {
    const name = this.#identity.providerName
    return `Domovoi stopped the ${name} server because it could not confirm that a session it stopped had stopped`
  }

  // Ends the server and every session on it. Each loaded thread's turn fails
  // with the reason, nothing more is sent to the server, and the daemon hears
  // the provider disconnected, so the next message starts a new server.
  async #stopServer(reason: string): Promise<void> {
    const runtime = this.#runtime
    this.#runtime = undefined
    for (const directory of this.#directories.values()) directory.controller.abort()
    this.#directories.clear()
    this.#pendingApprovals.clear()
    this.#failedRefusals.clear()
    for (const session of this.#sessions.values()) this.#complete(session, "failed", reason)
    this.#sessions.clear()
    this.#subagents = new SubagentRegistry()
    this.#sentReplies.clear()
    this.#cascadeRejections.clear()
    // Retired before anything is awaited, so no other server can start
    // while this one is being stopped.
    const stopped = runtime ? await this.#retire(runtime.server) : true
    const name = this.#identity.providerName
    this.#emit({
      type: "provider-disconnected",
      reason: stopped
        ? reason
        : `${reason}. Domovoi could not confirm that the server and the programs it started have ended, `
          + `so it starts no other ${name} server until it can. Each new message checks again`,
    })
  }

  // Stops a server and keeps it until it is confirmed gone. A stop already
  // under way is shared rather than repeated. Resolves true once it is gone.
  #retire(server: OpenCodeServer): Promise<boolean> {
    this.#retiredServer = server
    this.#retiring ??= server.stop().catch(() => false).then((stopped) => {
      if (stopped && this.#retiredServer === server) this.#retiredServer = undefined
    }).finally(() => {
      this.#retiring = undefined
    })
    return this.#retiring.then(() => this.#retiredServer !== server)
  }

  #retiredServerRefusal(server: OpenCodeServer): string {
    const name = this.#identity.providerName
    const group = server.processGroup === undefined ? "" : ` (process group ${server.processGroup})`
    return `Domovoi could not confirm that the earlier ${name} server and the programs it started have ended, `
      + `so it starts no other ${name} server. Each new message checks again. To continue sooner, end those `
      + `programs${group} or restart Domovoi.`
  }

  #receiveTool(session: Session, turnId: string, part: Record<string, unknown>): void {
    const callId = typeof part.callID === "string" ? part.callID : undefined
    const tool = typeof part.tool === "string" ? part.tool : undefined
    const state = asRecord(part.state)
    if (!callId || !tool || !state || typeof state.status !== "string") return
    if (session.toolPhases.get(callId) === state.status) return
    session.toolPhases.set(callId, state.status)
    const input = asRecord(state.input) ?? {}
    const command = typeof input.command === "string" ? input.command : tool
    if (state.status === "running" && tool === "bash") {
      this.#emit({
        type: "item",
        phase: "started",
        params: {
          threadId: session.threadId,
          turnId,
          item: { type: "commandExecution", id: callId, command: [command], status: "inProgress" },
        },
      })
      return
    }
    if (state.status !== "completed" && state.status !== "error") return
    if (tool === "bash") {
      this.#emit({
        type: "item",
        phase: "completed",
        params: {
          threadId: session.threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: callId,
            command: [command],
            status: state.status === "error" ? "failed" : "completed",
            aggregatedOutput: typeof state.output === "string"
              ? state.output
              : typeof state.error === "string" ? state.error : "",
          },
        },
      })
      return
    }
    const path = filePath(input)
    if (path && state.status === "completed") {
      this.#emit({
        type: "item",
        phase: "completed",
        params: {
          threadId: session.threadId,
          turnId,
          item: { type: "fileChange", id: callId, changes: [{ path }] },
        },
      })
    }
  }

  #complete(session: Session, status: "completed" | "failed", error?: string, failure?: ProviderFailure): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    // Before the refusals below, whose own rejections may still cover others.
    this.#forgetCascadeRejections(session.threadId)
    this.#emit({
      type: "turn-completed",
      params: {
        threadId: session.threadId,
        turnId,
        turn: { id: turnId, status, ...(error ? { error } : {}) },
        ...(failure ? { failure } : {}),
      },
    })
    if (session.interruptedTurnId === session.activeTurnId) delete session.interruptedTurnId
    delete session.activeTurnId
    delete session.activeTurnStarted
    session.toolPhases.clear()
    // A subagent's request cannot outlive the turn that started it. Refuse it
    // on the provider and forget it, so a later answer to its card does nothing.
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.subagentTurn?.threadId !== session.threadId || pending.subagentTurn.turnId !== turnId) continue
      this.#pendingApprovals.delete(requestId)
      this.#respond(pending, "reject", requestId)
    }
    this.#retryFailedRefusals(session.threadId)
  }

  #requireSession(threadId: string): Session {
    const session = this.#sessions.get(threadId)
    if (!session) {
      throw new Error(`${this.#identity.providerName} session ${threadId} is not loaded`)
    }
    return session
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function openCodeModel(id: string): { providerID: string; modelID: string } | undefined {
  const separator = id.indexOf("/")
  if (separator < 1 || separator === id.length - 1) return undefined
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) }
}

// `permission.updated` is the shape older servers send; `permission.asked`
// (opencode 1.18, kilo 7.7) names the permission and its patterns instead of a
// title and type, and nests the call id under `tool`.
//
// Only bash with its command is a shell command. An edit of one file named by
// its absolute path is the Edit file tool on that file (edit and write send
// one; a patch of several files does not), so its Always stays a rule for that
// file. Every other permission is the provider's own tool, named by the
// permission: webfetch, external_directory, and a tool server's tool, whose
// permission is its own name. None of those is resolved as a shell command.
// The permission is read from the field its event names it in, and only
// there: a permission.asked event without a string `permission` has no name,
// whatever a `type` field beside it says.
function permissionRequest(
  event: "permission.asked" | "permission.updated",
  properties: Record<string, unknown>,
  providerName: string,
): { permissionId: string; command: string; reason?: string; itemId?: string; path?: string; tool?: string } | undefined {
  if (typeof properties.id !== "string") return undefined
  const metadata = asRecord(properties.metadata)
  const named = event === "permission.asked" ? properties.permission : properties.type
  const kind = typeof named === "string" ? named : undefined
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : []
  const title = typeof properties.title === "string" ? properties.title : undefined
  const command = typeof metadata?.command === "string"
    ? metadata.command
    : title ?? (kind ? [kind, ...patterns].join(" ") : `${providerName} tool`)
  const reason = title ?? (kind && patterns.length > 0 ? `${kind}: ${patterns.join(", ")}` : kind)
  const call = asRecord(properties.tool)
  const itemId = typeof properties.callID === "string"
    ? properties.callID
    : typeof call?.callID === "string" ? call.callID : undefined
  const editedFile = typeof metadata?.filepath === "string"
    ? metadata.filepath
    : typeof metadata?.filePath === "string" ? metadata.filePath : undefined
  const edit = kind === "edit" && patterns.length <= 1 && editedFile !== undefined && isAbsolute(editedFile)
    ? editedFile
    : undefined
  const shell = kind === "bash" && typeof metadata?.command === "string"
  return {
    permissionId: properties.id,
    command: edit === undefined ? command : "Edit",
    ...(reason ? { reason } : {}),
    ...(itemId ? { itemId } : {}),
    ...(edit === undefined ? {} : { path: edit }),
    // A permission with no name is still a provider tool, never shell text.
    ...(shell || edit !== undefined ? {} : { tool: kind || "unknown" }),
  }
}

// kilo 7.8 permission/index.ts:295-304: a skill shell batch or a sandbox
// escalation takes only a reply marked interactive.
function interactiveOnly(properties: Record<string, unknown>): boolean {
  const metadata = asRecord(properties.metadata)
  return metadata?.skillShell === true || metadata?.sandboxEscalation === true
}

// How long a stop waits for the provider to confirm a run was aborted.
const abortConfirmMs = 10_000
// How long Domovoi waits for the server to accept or refuse its answer to a
// permission request. Past it the outcome is unknown, and a matching reply the
// server reported meanwhile counts as someone else's.
export const permissionAnswerConfirmMs = 10_000

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

function replyKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

function eventSessionId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === "string") return properties.sessionID
  const part = asRecord(properties.part)
  if (typeof part?.sessionID === "string") return part.sessionID
  const info = asRecord(properties.info)
  return typeof info?.sessionID === "string" ? info.sessionID : undefined
}

function filePath(input: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path"]) {
    if (typeof input[key] === "string") return input[key]
  }
  return undefined
}

function errorMessage(error: Record<string, unknown> | undefined, providerName: string): string {
  const data = asRecord(error?.data)
  if (typeof data?.message === "string") return data.message
  if (typeof error?.message === "string") return error.message
  return `${providerName} session failed`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalidData(action: string): never {
  throw new Error(`${action} returned invalid data`)
}

function requireConfig(value: unknown, action: string): OpenCodeConfig {
  const config = asRecord(value)
  if (!config || (config.model !== undefined && typeof config.model !== "string")) {
    return invalidData(action)
  }
  return { ...(typeof config.model === "string" ? { model: config.model } : {}) }
}

function requireCatalog(value: unknown, action: string): OpenCodeCatalog {
  const catalog = asRecord(value)
  const defaults = asRecord(catalog?.default)
  if (!catalog || !defaults || !Array.isArray(catalog.providers)) return invalidData(action)
  if (Object.values(defaults).some((model) => typeof model !== "string")) return invalidData(action)

  const providers: OpenCodeCatalog["providers"] = []
  for (const candidate of catalog.providers) {
    const provider = asRecord(candidate)
    const models = asRecord(provider?.models)
    if (!provider || typeof provider.id !== "string" || typeof provider.name !== "string" || !models) {
      return invalidData(action)
    }
    const validatedModels: OpenCodeCatalog["providers"][number]["models"] = {}
    for (const [key, candidateModel] of Object.entries(models)) {
      const model = asRecord(candidateModel)
      const capabilities = model?.capabilities === undefined
        ? undefined
        : asRecord(model.capabilities)
      if (
        !model
        || typeof model.id !== "string"
        || typeof model.name !== "string"
        || (model.status !== undefined && typeof model.status !== "string")
        || (model.capabilities !== undefined && !capabilities)
        || (capabilities?.reasoning !== undefined && typeof capabilities.reasoning !== "boolean")
      ) return invalidData(action)
      validatedModels[key] = {
        id: model.id,
        name: model.name,
        ...(typeof model.status === "string" ? { status: model.status } : {}),
        ...(capabilities ? { capabilities: { reasoning: capabilities.reasoning === true } } : {}),
      }
    }
    providers.push({ id: provider.id, name: provider.name, models: validatedModels })
  }
  const validatedDefaults: Record<string, string> = {}
  for (const [provider, model] of Object.entries(defaults)) {
    if (typeof model === "string") validatedDefaults[provider] = model
  }
  return { providers, default: validatedDefaults }
}

function requireSession(value: unknown, action: string): { id: string } {
  const session = asRecord(value)
  if (!session || typeof session.id !== "string") return invalidData(action)
  return { id: session.id }
}

function requireEventSubscription(
  value: unknown,
  action: string,
): { stream: AsyncIterable<OpenCodeEvent> } {
  const subscription = asRecord(value)
  if (!subscription || !isAsyncIterable(subscription.stream)) return invalidData(action)
  return { stream: subscription.stream }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenCodeEvent> {
  return value !== null
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function"
}

export function requireOpenCodeClient(value: unknown, providerName: string): OpenCodeClient {
  if (!isOpenCodeClient(value)) throw new Error(`${providerName} client returned invalid data`)
  return value
}

function isOpenCodeClient(value: unknown): value is OpenCodeClient {
  const client = asRecord(value)
  const config = asRecord(client?.config)
  const session = asRecord(client?.session)
  const event = asRecord(client?.event)
  return Boolean(
    client
    && config
    && typeof config.get === "function"
    && typeof config.providers === "function"
    && session
    && typeof session.create === "function"
    && typeof session.get === "function"
    && typeof session.delete === "function"
    && typeof session.abort === "function"
    && typeof session.promptAsync === "function"
    && typeof session.messages === "function"
    && event
    && typeof event.subscribe === "function"
    && typeof client.postSessionIdPermissionsPermissionId === "function"
  )
}

function unwrap<T>(result: OpenCodeResult<T>, action: string): T {
  if (result.error !== undefined) throw new Error(`${action} failed`)
  if (result.data === undefined) throw new Error(`${action} returned no data`)
  return result.data
}

function ensureSuccess(result: OpenCodeResult<unknown>, action: string): void {
  if (result.error !== undefined) throw new Error(`${action} failed`)
}

// Every agent, including the built-in subagents the task tool starts, asks
// before it edits, runs a command, fetches or leaves the project. A subagent
// keeps only its parent's deny rules, so a per-agent "ask" does not reach it.
export const domovoiAgentPermission = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  doom_loop: "ask",
  external_directory: "ask",
} as const

export const domovoiOpenCodeConfig: Config = {
  autoupdate: false,
  permission: domovoiAgentPermission,
  agent: {
    "domovoi-ask": {
      mode: "primary",
      description: "Domovoi read-only ask mode",
      tools: {
        "*": false,
        read: true,
        glob: true,
        grep: true,
        list: true,
        webfetch: true,
        websearch: true,
        question: true,
      },
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        external_directory: "deny",
      },
    },
    plan: {
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        external_directory: "deny",
      },
    },
    build: {
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        doom_loop: "ask",
        external_directory: "ask",
      },
    },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        doom_loop: "ask",
        external_directory: "ask",
      },
    },
  },
}

const defaultOpenCodeFactory: OpenCodeFactory = async () => {
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "OPENCODE_SERVER_PASSWORD",
    usernameEnvironment: "OPENCODE_SERVER_USERNAME",
    username: "opencode",
    // What the SDK's createOpencodeServer passes, plus the project switch.
    environment: {
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(domovoiOpenCodeConfig),
    },
    startServer: embeddedServerCommand("opencode", "opencode server listening"),
    createClient: createOpencodeClient,
  })
  return {
    client: requireOpenCodeClient(runtime.client, "OpenCode"),
    server: runtime.server,
  }
}
