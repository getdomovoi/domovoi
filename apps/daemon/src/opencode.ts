import { randomBytes } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
} from "@opencode-ai/sdk"
import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { normalizeProviderUsage } from "./usage.js"
import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
import { projectInstructions } from "./project-instructions.js"

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
  // The tool servers a directory knows, by name, and the ids of its tools
  // other than tool servers'. Read before a session opens and before each
  // prompt; without them no session opens (#refuseUnownedNames).
  mcp?: {
    status(options: MethodOptions<OpencodeSdkClient["mcp"]["status"]>): Promise<OpenCodeResult<unknown>>
  }
  tool?: {
    ids(options: MethodOptions<OpencodeSdkClient["tool"]["ids"]>): Promise<OpenCodeResult<unknown>>
  }
  // The agents with their merged rules, checked with the catalog.
  app?: {
    agents(options: MethodOptions<OpencodeSdkClient["app"]["agents"]>): Promise<OpenCodeResult<unknown>>
  }
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

// How long a card waits for its directory's tool servers to be read again.
const catalogReadTimeoutMs = 1_000

// A tool that is not the server's own could ask under a permission the
// embedded config names (#refuseUnownedNames).
export class UnownedToolError extends Error {}

// A tool server's name as its tools' keys start: OpenCode and Kilo turn every
// UTF-16 unit outside [a-zA-Z0-9_-] into `_` (mcp/catalog.ts sanitize, a
// non-Unicode /g replace).
export const openCodeToolPrefixName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_")

export type OpenCodeFactory = () => Promise<{
  client: OpenCodeClient
  server: { close(): void }
}>

export type OpenCodeAdapterIdentity = {
  providerId: string
  providerName: string
  heldBackRepositoryFiles?: readonly string[]
  // The permissions the server's own tools ask under, the ids of the tools it
  // registers itself, and the permissions the embedded config allows. A tool
  // server whose tools could take one of those permissions, or a tool that is
  // not the server's own but could ask under an allowed one, refuses the
  // session (#refuseUnownedNames).
  builtInPermissions?: ReadonlySet<string>
  builtInToolIds?: readonly string[]
  allowedPermissions?: ReadonlySet<string>
  // The agents a Domovoi session runs: its primary agents and the subagents
  // they start without a card. Each must ask before a tool it does not name.
  sessionAgents?: readonly string[]
}

const openCodeSessionAgents: readonly string[] = ["build", "plan", "domovoi-auto", "domovoi-ask", "general", "explore"]

// Names no tool has, to test whether an agent's merged rules allow a tool
// they do not name: one shaped like a tool server's tool key, one not.
const unnamedToolProbes = ["domovoi_unnamed_tool", "domovoiunnamedtool"]

// The server's rule matching (packages/core/src/util/wildcard.ts at opencode
// v1.18.32 and kilo v7.8.1): `*` is any run, `?` any one character, a
// trailing " *" also matches nothing, and Windows matches in any case.
function wildcardMatches(input: string, pattern: string): boolean {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"))
}

// The action the last matching rule gives, as the server evaluates it; no
// matching rule asks.
function ruleAction(rules: readonly unknown[], permission: string): unknown {
  const rule = rules.findLast((candidate) => {
    const record = asRecord(candidate)
    return typeof record?.permission === "string" && typeof record.pattern === "string"
      && wildcardMatches(permission, record.permission) && wildcardMatches("*", record.pattern)
  })
  return rule === undefined ? "ask" : asRecord(rule)?.action
}

// What a directory's instance was last read to hold: its tool servers by
// name, and its tool ids.
type ToolCatalog = { servers: readonly string[]; toolIds: ReadonlySet<string> }

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
  // Each directory's tool catalog, as last read, and a read of its tool
  // servers a card is waiting on.
  #catalogs = new Map<string, ToolCatalog>()
  #catalogReads = new Map<string, Promise<void>>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #subagents = new SubagentRegistry()
  // Refusals the provider did not accept, by request id. They are sent again
  // when the card is answered or the thread's next turn starts or ends.
  #failedRefusals = new Map<number, PendingApproval>()
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
    await this.#refuseUnownedNames(client, cwd)
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
      await this.#refuseUnownedNames(client, cwd)
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
    void this.#client().then(async (client) => {
      unwrap(await client.postSessionIdPermissionsPermissionId({
        path: { id: pending.providerSessionId, permissionID: pending.permissionId },
        query: { directory: pending.cwd },
        body: { response },
        throwOnError: true,
      }), `${this.#identity.providerName} permission response`)
    }).catch((error: unknown) => {
      console.error(`Domovoi could not resolve a ${this.#identity.providerName} permission`, error)
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
    this.#runtime?.server.close()
    this.#runtime = undefined
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
    const directory: DirectoryStream = { controller, threadIds: new Set([threadId]) }
    this.#directories.set(cwd, directory)
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

  #disconnect(cwd: string, controller: AbortController, reason: string): void {
    if (controller.signal.aborted) return
    controller.abort()
    this.#directories.delete(cwd)
    for (const session of this.#sessions.values()) {
      if (session.cwd !== cwd) continue
      this.#complete(session, "failed", reason)
      this.#refusePendingFor(session.threadId)
      this.#forgetSubagents(session.threadId)
      this.#sessions.delete(session.threadId)
    }
    this.#emit({ type: "provider-disconnected", reason })
  }

  // A permission names no tool, so a tool that is not the server's own could
  // ask under a permission the embedded config allows and run without a card
  // (security review round 1 of #687). A tool server's tool asks under
  // `<server>_<tool>` (opencode mcp/catalog.ts toolName), and a plugin's tool
  // under whatever it names, its id by convention. Before a session opens and
  // before each prompt this reads the directory's tool servers and tool ids
  // (the server starts the person's tool servers as it answers, as the first
  // prompt would) and refuses:
  //   - a tool server whose tool key could be one of the server's own
  //     permissions, compared in any case, as Windows matches rules;
  //   - a tool id listed twice, or one the server does not register itself
  //     that shares a name with a permission the config allows;
  //   - when either cannot be read.
  // A tool server or plugin added while a turn runs is checked at the next
  // prompt. A plugin tool that asks under another name, or does not ask, is
  // the person's own code and is not caught here.
  async #refuseUnownedNames(client: OpenCodeClient, cwd: string): Promise<void> {
    const name = this.#identity.providerName
    const unreadable = new Error(
      `Domovoi could not read ${name}'s tool servers and tools for this worktree, so it cannot tell whether a tool could run without approval. Try again.`,
    )
    if (!client.mcp || !client.tool || !client.app) throw unreadable
    let catalog: ToolCatalog
    let agents: unknown[]
    try {
      const servers = asRecord(unwrap(await client.mcp.status({ query: { directory: cwd }, throwOnError: true }), `${name} tool server status`))
      const ids = unwrap(await client.tool.ids({ query: { directory: cwd }, throwOnError: true }), `${name} tool ids`)
      const listedAgents = unwrap(await client.app.agents({ query: { directory: cwd }, throwOnError: true }), `${name} agents`)
      if (!servers || !Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) throw unreadable
      if (!Array.isArray(listedAgents)) throw unreadable
      agents = listedAgents
      const listed = new Set<string>()
      for (const id of ids) {
        if (listed.has(id)) throw this.#unownedTool(id)
        listed.add(id)
      }
      catalog = { servers: Object.keys(servers), toolIds: listed }
    } catch (error) {
      if (error instanceof UnownedToolError) throw error
      throw unreadable
    }
    this.#catalogs.set(cwd, catalog)
    const builtInPermissions = [...this.#identity.builtInPermissions ?? openCodeBuiltInPermissions]
    for (const server of catalog.servers) {
      const prefix = `${openCodeToolPrefixName(server)}_`.toLowerCase()
      const taken = builtInPermissions.filter((permission) => permission.toLowerCase().startsWith(prefix))
      if (taken.length > 0) {
        throw new UnownedToolError(
          `${name} has a tool server named "${server}", whose tools could be named like ${name}'s own ${taken.join(", ")}, so a call to one could run without approval. `
          + `Rename or turn off that tool server to use ${name} here.`,
        )
      }
    }
    const builtInToolIds = new Set(this.#identity.builtInToolIds ?? openCodeBuiltInToolIds)
    const allowed = this.#identity.allowedPermissions ?? openCodeAllowedPermissions
    for (const id of catalog.toolIds) {
      if (!builtInToolIds.has(id) && allowed.has(id)) throw this.#unownedTool(id)
    }
    // Config this adapter does not see, an agent or mode block of the
    // person's, an organization's or a managed config, can still leave an
    // agent allowing a tool it does not name (security review round 2 of
    // #687). The agents' merged rules, as the server will judge calls, are
    // checked: an agent a session runs must not allow a name no rule names.
    // A rule of the person's for a named tool stands. An agent the server
    // does not list is not run.
    const runs = new Set(this.#identity.sessionAgents ?? openCodeSessionAgents)
    for (const agent of agents) {
      const record = asRecord(agent)
      if (typeof record?.name !== "string" || !runs.has(record.name)) continue
      const rules = Array.isArray(record.permission) ? record.permission : undefined
      if (rules === undefined || unnamedToolProbes.some((probe) => ruleAction(rules, probe) === "allow")) {
        throw new UnownedToolError(
          `${name}'s ${record.name} agent allows a tool it does not name, so a tool server's tool could run there without approval. `
          + `A rule in your own ${name} configuration, such as a "*" rule in an agent or mode block, allows it; remove that rule to use ${name} here.`,
        )
      }
    }
  }

  // Whether a card for `permission` could name a tool server the catalog does
  // not know yet: not one of the server's own permissions or tool ids, and
  // not placed on exactly one known server (security review round 1 of #687:
  // a card must not go out without the attribution a read would give).
  #mayNeedFreshCatalog(cwd: string, permission: string): boolean {
    if ((this.#identity.builtInPermissions ?? openCodeBuiltInPermissions).has(permission)) return false
    const catalog = this.#catalogs.get(cwd)
    return catalog === undefined || (!catalog.toolIds.has(permission) && this.#toolServerOf(cwd, permission) === undefined)
  }

  // Reads the directory's tool servers again, waiting at most a second, so a
  // card names a server added since the last read. A read already running is
  // shared. A failed or slow read leaves the catalog as it was, and the next
  // card that needs it reads again.
  #refreshToolServers(cwd: string): Promise<void> {
    const running = this.#catalogReads.get(cwd)
    if (running) return running
    const read = (async () => {
      const client = this.#runtime?.client
      const catalog = this.#catalogs.get(cwd)
      if (!client?.mcp || catalog === undefined) return
      try {
        const servers = asRecord(unwrap(await client.mcp.status({
          query: { directory: cwd },
          signal: AbortSignal.timeout(catalogReadTimeoutMs),
          throwOnError: true,
        }), `${this.#identity.providerName} tool server status`))
        if (servers && this.#catalogs.get(cwd) === catalog) this.#catalogs.set(cwd, { ...catalog, servers: Object.keys(servers) })
      } catch {
        // The card goes out without a tool server; the next one reads again.
      }
    })()
    // The answer may never come; the card does not wait past the bound.
    const bounded = Promise.race([read, new Promise<void>((resolve) => setTimeout(resolve, catalogReadTimeoutMs).unref())])
      .finally(() => {
        if (this.#catalogReads.get(cwd) === bounded) this.#catalogReads.delete(cwd)
      })
    this.#catalogReads.set(cwd, bounded)
    return bounded
  }

  #unownedTool(id: string): UnownedToolError {
    const name = this.#identity.providerName
    return new UnownedToolError(
      `${name} has a tool named "${id}" that is not one of its own but shares a name with one, so a call to it could run without approval. `
      + `Remove or rename that tool to use ${name} here.`,
    )
  }

  // The tool server whose tool asks under `permission`, from the directory's
  // catalog: the one server whose name, made a tool key prefix as the server
  // makes it (openCodeToolPrefixName, then `_`), starts the permission. None
  // for a permission that is one of the directory's tool ids (a plugin's tool
  // or the server's own), and none when no server or more than one could
  // have made it, so a card never names a server the call may not reach. A
  // server whose tools could take one of the server's own permissions refuses
  // the session (#refuseUnownedNames), so no such name is left to suppress.
  #toolServerOf(cwd: string, permission: string): string | undefined {
    const catalog = this.#catalogs.get(cwd)
    if (catalog === undefined || catalog.toolIds.has(permission)) return undefined
    const matches = catalog.servers.filter((name) => permission.startsWith(`${openCodeToolPrefixName(name)}_`))
    return matches.length === 1 ? matches[0] : undefined
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
    await this.#refuseUnownedNames(client, session.cwd)
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
      })
      const raise = () => {
        // Answered or refused while the catalog was read: nothing to show.
        if (!this.#pendingApprovals.has(requestId)) return
        const toolServer = request.tool === undefined ? undefined : this.#toolServerOf(cwd, request.tool)
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
          ...(toolServer !== undefined ? { toolServer: { name: toolServer } } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
        })
      }
      if (request.tool === undefined || !this.#mayNeedFreshCatalog(cwd, request.tool)) raise()
      else void this.#refreshToolServers(cwd).then(raise)
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

  #complete(session: Session, status: "completed" | "failed", error?: string): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    this.#emit({
      type: "turn-completed",
      params: {
        threadId: session.threadId,
        turnId,
        turn: { id: turnId, status, ...(error ? { error } : {}) },
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

// How OpenCode (and Kilo, its fork) decide: each agent's rules are the
// server's defaults, then the agent's own built-in rules, then the person's
// merged `permission` (where this config's top-level block lands), then this
// config's block for that agent, and the last rule that matches wins. Read
// from anomalyco/opencode v1.18.32 permission/index.ts and agent/agent.ts,
// and checked against `opencode serve`'s /agent answer.
//
// Ruling Q155 A: every tool that is not one of the server's own asks first,
// so a tool server's tool, the person's own included, gets an approval card.
// That is the catch-all "*" below. It comes first so every rule after it
// still applies, and it overrides the defaults and built-in rules before it,
// so those are restated after it as they were (ruling Q229 A):
//   - the tools the defaults allow, and their ask for .env files;
//   - the tools the defaults deny;
//   - each agent's own allows and denies, in this config's agent blocks.
// task and todowrite are restated only in the primary agents' blocks: a
// subagent whose rules name neither is denied both by its session, as before.
// The person's own per-agent rules are merged into this config's block for
// that agent, after the top-level block, so every agent block starts with its
// own catch-all too and restates the defaults after it; a person's "*" rule
// for that agent takes the catch-all's place and value (security review round
// 1 of #687).
// Every agent, the built-in subagents the task tool starts included, asks
// before it edits, runs a command, fetches or leaves the project. A subagent
// keeps only its parent's deny rules, so a per-agent "ask" does not reach it.
// opencode-permission.test.ts holds every agent a session runs to the
// actions it had before, apart from tools that are not the server's own.
export const askBeforeEdits = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  doom_loop: "ask",
  external_directory: "ask",
} as const

// The read rules the servers' defaults give every agent.
export const defaultReads = { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" } as const

// The built-in tools OpenCode's defaults allow and deny. Kilo adds its own
// (kilo-runtime.ts).
export const openCodeDefaultAllows = ["glob", "grep", "list", "lsp", "skill", "websearch"] as const
export const openCodeDefaultDenies = ["question", "plan_enter", "plan_exit"] as const

// Every permission OpenCode's own tools ask under.
export const openCodeBuiltInPermissions: ReadonlySet<string> = new Set([
  ...openCodeDefaultAllows,
  ...openCodeDefaultDenies,
  ...Object.keys(askBeforeEdits),
  "read",
  "task",
  "todowrite",
])

// The tools OpenCode registers itself under Domovoi's embedded server, as its
// tool ids list them (`opencode serve` 1.18.32, /experimental/tool/ids).
export const openCodeBuiltInToolIds: readonly string[] = [
  "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch",
]

export const permissionActions =<Action extends "allow" | "deny">(names: readonly string[], action: Action) => (
  Object.fromEntries(names.map((name) => [name, action])) as Record<string, Action>
)

export function domovoiPermission(allows: readonly string[], denies: readonly string[]) {
  return {
    "*": "ask",
    read: defaultReads,
    ...permissionActions(allows, "allow"),
    ...permissionActions(denies, "deny"),
    ...askBeforeEdits,
  } as const
}

export const domovoiAgentPermission = domovoiPermission(openCodeDefaultAllows, openCodeDefaultDenies)

// Domovoi's read-only Ask agent: every tool off but the reading ones.
export const domovoiAskAgent = {
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
    // The tools block above starts with "*": deny; stating it here keeps a
    // person's own "*" for this agent from replacing it.
    "*": "deny",
    edit: "deny",
    bash: "deny",
    webfetch: "allow",
    external_directory: "deny",
  },
} as const

// Which subagents a primary agent starts without a card: the server's own
// general and explore. A subagent of the person's own runs by its own rules,
// which may allow what this config asks about, so starting it asks.
export const builtInSubagents = { "*": "ask", general: "allow", explore: "allow" } as const
export const planSubagents = { "*": "ask", general: "deny", explore: "allow" } as const

// What Plan may not do, on top of its built-in rules.
export const domovoiPlanLimits = {
  edit: "deny",
  bash: "deny",
  webfetch: "allow",
  external_directory: "deny",
} as const

// The agent blocks as the servers take them. The SDK's generated agent type
// names five permissions; the server's schema takes any permission name
// (packages/core/src/v1/config/permission.ts, a struct with a string rest).
type PermissionAction = "allow" | "ask" | "deny"
export type EmbeddedAgents = Record<string, {
  mode?: "primary"
  description?: string
  tools?: Readonly<Record<string, boolean>>
  permission: Readonly<Record<string, PermissionAction | Readonly<Record<string, PermissionAction>>>>
}>

// A person's deprecated `mode` block is merged into the agent of its name
// after every config source, this one included (config/config.ts in both
// servers), so it could restore a final "*": "allow" over an agent block.
// The primary agents' blocks are set under `mode` too: the person's and this
// config's mode blocks merge first, this config's values winning, and that is
// what lands on the agent (security review round 2 of #687). Subagents are
// left out: a mode block makes its agent primary, which the task tool cannot
// start.
export function withModeBlocks(agents: EmbeddedAgents, primaries: readonly string[]): { agent: EmbeddedAgents; mode: EmbeddedAgents } {
  return { agent: agents, mode: Object.fromEntries(primaries.flatMap((name) => (agents[name] ? [[name, agents[name]]] : []))) }
}

const openCodeAgentBlocks = withModeBlocks({
  "domovoi-ask": domovoiAskAgent,
  plan: {
    permission: {
      ...domovoiAgentPermission,
      question: "allow",
      plan_exit: "allow",
      task: planSubagents,
      todowrite: "allow",
      ...domovoiPlanLimits,
    },
  },
  build: {
    permission: { ...domovoiAgentPermission, question: "allow", plan_enter: "allow", task: builtInSubagents, todowrite: "allow" },
  },
  "domovoi-auto": {
    mode: "primary",
    description: "Domovoi automatic build mode",
    permission: { ...domovoiAgentPermission, task: builtInSubagents, todowrite: "allow" },
  },
  general: { permission: { ...domovoiAgentPermission, todowrite: "deny" } },
  explore: {
    permission: { "*": "deny", grep: "allow", glob: "allow", list: "allow", websearch: "allow", read: "allow", ...askBeforeEdits },
  },
  // OpenCode's own agents for compaction, titles and summaries deny every
  // tool before the person's rules.
  ...Object.fromEntries(["compaction", "title", "summary"].map((name) => [name, { permission: { "*": "deny", ...askBeforeEdits } }])),
}, ["build", "plan", "domovoi-auto", "domovoi-ask"])

export const domovoiOpenCodeConfig: Config = {
  autoupdate: false,
  permission: domovoiAgentPermission,
  agent: openCodeAgentBlocks.agent as NonNullable<Config["agent"]>,
  mode: openCodeAgentBlocks.mode as NonNullable<Config["mode"]>,
}

// Every permission an embedded config allows in some agent, for any pattern,
// read from the config itself: its top-level block, each agent block, and an
// agent's legacy tools switched on.
export function allowedPermissionNames(config: { permission?: unknown; agent?: unknown }): ReadonlySet<string> {
  const allowed = new Set<string>()
  const read = (block: unknown) => {
    for (const [permission, action] of Object.entries(asRecord(block) ?? {})) {
      const allows = action === "allow" || action === true || Object.values(asRecord(action) ?? {}).includes("allow")
      if (permission !== "*" && allows) allowed.add(permission)
    }
  }
  read(config.permission)
  for (const agent of Object.values(asRecord(config.agent) ?? {})) {
    read(asRecord(agent)?.permission)
    read(asRecord(agent)?.tools)
  }
  return allowed
}

export const openCodeAllowedPermissions = allowedPermissionNames(domovoiOpenCodeConfig)

const defaultOpenCodeFactory: OpenCodeFactory = async () => {
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "OPENCODE_SERVER_PASSWORD",
    usernameEnvironment: "OPENCODE_SERVER_USERNAME",
    username: "opencode",
    environment: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    config: domovoiOpenCodeConfig,
    startServer: createOpencodeServer,
    createClient: createOpencodeClient,
  })
  return {
    client: requireOpenCodeClient(runtime.client, "OpenCode"),
    server: runtime.server,
  }
}
