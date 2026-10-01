import { randomBytes } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import {
  createOpencodeClient,
  type Config,
} from "@opencode-ai/sdk"
import type { ApprovalDecision, ProviderFailure, ProviderModel, Runtime } from "@getdomovoi/protocol"

import { ApprovalRequestNotPendingError, type AgentAdapter, type AgentEvent } from "./agents.js"
import { approvalAnsweredElsewhereFailure as approvalAnsweredElsewhere } from "./provider-failures.js"
import { normalizeProviderUsage } from "./usage.js"
import { createAuthenticatedEmbeddedRuntime, embeddedServerCommand, type EmbeddedServer } from "./embedded-server.js"
import { requireTestedVersion, type TestedVersion } from "./embedded-version.js"
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
      signal?: AbortSignal
      throwOnError: true
    }): Promise<OpenCodeResult<unknown> & { response?: Response }>
    // GET /session/status (SDK `session.status`; opencode SDK 1.18.32 and
    // kilo SDK 7.7.9, SessionStatusResponses): each session that is not idle,
    // by id, as `{ type: "busy" }` or `{ type: "retry", ... }`. The servers
    // drop a session from it when it goes idle (SessionStatus.set in opencode
    // 1.18.32/1.18.33 and kilo 7.8.1), so an absent session is idle.
    status(options: {
      query: { directory: string }
      signal?: AbortSignal
      throwOnError: true
    }): Promise<OpenCodeResult<unknown>>
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

// How long Domovoi waits for the server to answer an abort before it treats
// the abort as failed (#sendAbort).
const abortAnswerTimeoutMs = 10_000

// How long Domovoi waits for a stopped server to be confirmed gone, the
// process group or tree and its own exit included, before it counts the stop
// as unconfirmed (#retire).
const serverStopConfirmMs = 20_000

// A turn the events left open is settled from the server's own state
// (#reconcile, security review round 9 of #687, ruling Q294): two seconds
// after an idle or error that did not end it, or after an abort for it that
// failed, and again after a failed or inconclusive read 1, 2, 4, 8 and 15
// seconds later (thirty seconds in all) before Domovoi gives up. Each read
// is bounded at five seconds.
const reconcileDelayMs = 2_000
const reconcileRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000] as const
const reconcileReadTimeoutMs = 5_000

// What a turn aborted for a tool change says of the abort: a stated limit,
// not a gate (#watchToolCall).
const abortLimit = "The call that showed it may already have run, and a tool that is running may not stop for the abort."

// Tools the server adds to a turn outside its tool registry, so its tool ids
// do not list them (session/tools.ts and session/prompt.ts at opencode
// v1.18.32 and kilo v7.8.1): the tool server resource tools, structured
// output, the no-op some providers need, and the invalid-call stand-in.
const serverInjectedTools: ReadonlySet<string> = new Set([
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "StructuredOutput", "_noop", "invalid",
])

// A tool that is not the server's own could ask under a permission the
// embedded config names (#refuseUnownedNames).
export class UnownedToolError extends Error {}

// A tool server's name as its tools' keys start: OpenCode and Kilo turn every
// UTF-16 unit outside [a-zA-Z0-9_-] into `_` (mcp/catalog.ts sanitize, a
// non-Unicode /g replace).
export const openCodeToolPrefixName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_")

type OpenCodeServer = Pick<EmbeddedServer, "close" | "stop" | "processGroup" | "processKind">

export type OpenCodeFactory = () => Promise<{
  client: OpenCodeClient
  server: OpenCodeServer

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
  // The server's name for the primary agent Domovoi asks for (Kilo runs
  // build as code).
  agentName?: (agent: string) => string
}

// The server's rule matching (packages/core/src/util/wildcard.ts, the same
// file at opencode v1.18.32, v1.18.33 and kilo v7.8.1): every backslash
// becomes a slash in both the pattern and the input, `*` is any run, `?` any
// one character, a trailing " *" also matches nothing, and Windows matches
// in any case.
const ruleText = (name: string) => name.replaceAll("\\", "/")

function wildcardMatches(input: string, pattern: string, platform: NodeJS.Platform): boolean {
  let escaped = ruleText(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, platform === "win32" ? "si" : "s").test(ruleText(input))
}

// Whether the server's rules read two names as one. Both sides take the
// matcher's backslash-to-slash step on every platform, so "a\b" and "a/b"
// are one name. On Windows the matcher then compares in any case with a
// RegExp "i" flag and no "u" flag, whose case folding is not toLowerCase:
// "Σ" and "ς" match though their lower cases differ. Elsewhere the names
// must then be equal (security review rounds 4 and 5 of #687).
function sameRuleName(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = ruleText(a)
  const right = ruleText(b)
  if (platform !== "win32") return left === right
  // Every special character of the name is escaped, so it matches only itself.
  return new RegExp(`^${left.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(right)
}

export type OpenCodeAdapterOptions = {
  // The platform the server runs on, whose rule matching the checks follow.
  // The daemon's own; tests set it.
  platform?: NodeJS.Platform
}

// The agents a session can reach from the primary agent it runs (security
// review round 3 of #687): that agent, and every agent the task tool can
// start from it, which is any agent whose effective mode is not primary and
// whose start the primary's task rule does not deny. An agent asked for that
// the server does not list is undefined.
function reachableAgents(agents: readonly unknown[], primary: string, platform: NodeJS.Platform): Array<{ name: string; permission: unknown }> | undefined {
  const listed = agents.flatMap((agent) => {
    const record = asRecord(agent)
    return typeof record?.name === "string" ? [{ name: record.name, mode: record.mode, permission: record.permission }] : []
  })
  const selected = listed.find((agent) => agent.name === primary)
  const rules = selected === undefined ? undefined : mergedRules(selected.permission)
  if (selected === undefined || rules === undefined) return selected === undefined ? undefined : [selected]
  const starts = (name: string) => rules.findLast((rule) => wildcardMatches("task", rule.permission, platform) && wildcardMatches(name, rule.pattern, platform))?.action !== "deny"
  return [selected, ...listed.filter((agent) => agent.name !== primary && agent.mode !== "primary" && starts(agent.name))]
}

type MergedRule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

// An agent's merged rules as the server lists them (app.agents), in the order
// it judges them, or undefined when one is not a rule of that shape.
function mergedRules(value: unknown): MergedRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rules: MergedRule[] = []
  for (const item of value as unknown[]) {
    const rule = asRecord(item)
    if (typeof rule?.permission !== "string" || typeof rule.pattern !== "string") return undefined
    if (rule.action !== "allow" && rule.action !== "ask" && rule.action !== "deny") return undefined
    rules.push({ permission: rule.permission, pattern: rule.pattern, action: rule.action })
  }
  return rules
}

// Why an agent's merged rules could let a tool that is not the server's own
// run without a card, or undefined when they cannot (security review rounds 2
// and 3 of #687). The server takes the last matching rule, and a rule for
// every permission and every pattern ("*", "*") matches every call, so every
// rule before the last such catch-all decides nothing. The checks are by
// shape, never by sampling names:
//   - the catch-all must be there and must ask or deny;
//   - every allow after it must name one of the server's own permissions
//     literally, with no `*` or `?`; its pattern may narrow it to arguments.
// So a wildcard allow (`*`, `mcp_*`, `gl?b`), a "*" rule for some arguments,
// and an allow for a named tool that is not the server's own all refuse.
function unnamedToolAllow(rules: readonly MergedRule[], builtIns: ReadonlySet<string>): { kind: "no-catch-all" } | { kind: "allow"; permission: string } | undefined {
  const last = rules.findLastIndex((rule) => rule.permission === "*" && rule.pattern === "*")
  if (last < 0 || rules[last]!.action === "allow") return { kind: "no-catch-all" }
  const opened = rules.slice(last + 1).find((rule) => rule.action === "allow" && (/[*?]/.test(rule.permission) || !builtIns.has(rule.permission)))
  return opened === undefined ? undefined : { kind: "allow", permission: opened.permission }
}

// What a directory's instance was last read to hold: its tool servers by
// name, and its tool ids.
type ToolCatalog = {
  servers: readonly string[]
  // Each server's status entry as mcp.status gave it (connected, failed,
  // disabled, needs_auth, with any error), so a server that connects, fails
  // or is replaced with a different status counts as changed. The status
  // answer names no more of a server than that: a replacement under the same
  // name with the same status is not visible (security review round 3 of
  // #687).
  serverStates: ReadonlyMap<string, string>
  // The servers and states as the check before the prompt read them. A card
  // that reads the servers again updates `servers` for its attribution only;
  // a turn's tool calls are held to what was checked.
  checkedStates: ReadonlyMap<string, string>
  toolIds: ReadonlySet<string>
}

// A tool server status answer's servers and the state of each.
function serverStatesOf(status: Record<string, unknown>): Map<string, string> {
  return new Map(Object.entries(status).map(([name, entry]) => {
    const record = asRecord(entry)
    return [name, JSON.stringify(record ? Object.entries(record).sort(([left], [right]) => left.localeCompare(right)) : entry)]
  }))
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
  // How far the active turn's own run has come, by message identity
  // (#turnEndOn, security review round 8 of #687, ruling Q287). `seen`: the
  // server showed the turn's prompt (its user message, whose id Domovoi
  // chose) or a reply to it or to one of its steers. `reply`: the latest such
  // reply, and whether it has completed or failed. `error`: a session error
  // after the turn was seen and since that reply began.
  activeTurn?: {
    seen?: true
    reply?: { done: boolean; error?: string }
    error?: string
  }
  // A read of the server's state scheduled for the active turn (#reconcile).
  // `retries` counts the reads that failed or settled nothing for want of
  // the prompt.
  reconcile?: { turnId: string; timer: ReturnType<typeof setTimeout>; retries: number }
  // Counts what the session did other than end: a prompt or steer sent, a
  // message or part updated, a status other than idle, an approval asked
  // for, its subagents' included. A read of the server's state (#reconcile)
  // is applied only if this did not move while it ran (security review round
  // 10 of #687).
  activity: number
  // The thread-wide stops under way, as one record (#holdThread): an
  // approval answered elsewhere, a request Domovoi cannot answer, a closed
  // event stream. Each aborts the thread and its subagents and then settles
  // with its failure. Until the last has settled, nothing else ends the turn
  // and no prompt is sent; then the turn ends once, with the failure first
  // in precedence (security review rounds 11 and 12 of #687).
  threadStop?: ThreadStop
  // Settles when the session is unloaded or dropped, or the adapter closes,
  // so a prompt waiting on a stop or an abort is refused rather than kept
  // waiting (#readyToSend). It says nothing about whether the provider, or
  // anything it started, has stopped (security review round 12 of #687).
  gone: Promise<void>
  leave: () => void
  // The catalog checked before the prompt that started the active turn. Every
  // prompt, a steer's included, is checked before it is sent, but only the
  // prompt that starts a turn sets this, and the turn's tool calls, a
  // steer's included, are held to it until the turn ends, never to the
  // directory's catalog or a steer's (security review rounds 4 to 6 of #687).
  checkedCatalog?: { turnId: string; catalog: ToolCatalog }
  assistantMessageTurnIds: Map<string, string>
  // The active turn's steers, by message id. A steer's reply names the steer
  // as its parent, and its tool calls are the turn's (security review round
  // 6 of #687).
  steerTurnIds: Map<string, string>
  toolPhases: Map<string, string>
  // Set while the thread is being stopped because an approval was answered
  // elsewhere. Its events are still read until the provider confirms the stop.
  stopping?: true
}

type DirectoryStream = {
  controller: AbortController
  threadIds: Set<string>
}

// How a thread-wide stop fails the turn. The failure first in precedence
// wins when stops overlap: an approval answered elsewhere (0), then a
// request Domovoi cannot answer (1), then a closed event stream (2). A
// server stop's own reason (#stopServer, 3) counts only when no stop
// settled with one of these.
type StopOutcome = { rank: 0 | 1 | 2 | 3; error: string; failure?: ProviderFailure }

// The thread-wide stops under way for one turn (#holdThread). Each owner
// settles once, on its own, with its outcome; no owner waits for another,
// so overlapping stops cannot wait on each other. An owner that settles
// while others remain leaves the session in place: what it would do with
// the session (unload it, drop it) waits in `disposals` and runs when the
// last owner settles, after the turn has ended once (security review round
// 13 of #687).
type ThreadStop = {
  turnId: string | undefined
  owners: number
  outcome?: StopOutcome
  disposals: Array<() => void>
  // Settles when the last owner has settled or the session is gone.
  cleared: Promise<void>
  clear: () => void
}

// An abort Domovoi sent to a provider session's run (#abortRun), recorded
// before it is sent and kept until the server answers or ten seconds pass
// (security review rounds 7 and 8 of #687). Every abort of a session goes
// through it: a stop, an interrupt, a thread stop and a run outside any turn.
// A second one while it is pending joins it. The aborted run's own end
// (errors and idles, which the servers publish in no fixed number) is not
// counted: a turn the abort stops ends on the answer, and a later turn only
// on an idle after its own reply completed (#turnEndOn).
type RunAbort = {
  // The Domovoi turns the abort concerns, and what its answer does to each:
  // a stop fails the turn with its reason, answered or not; an interrupt
  // fails it once answered; a hold (a thread stop) only keeps the run's end
  // from ending it while the abort is pending.
  turns: Map<string, { ends: "stop" | "interrupt" | "hold"; reason: string }>
  // Why it was sent, for a prompt that waits on an abort that fails.
  reason: string
  // True once the server answered the abort, false if it did not in time.
  settled: Promise<boolean>
  // Until the server answers or the bound passes.
  pending: boolean
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
  // Each directory's tool catalog, as last read, and a read of its tool
  // servers a card is waiting on.
  #catalogs = new Map<string, ToolCatalog>()
  #catalogReads = new Map<string, Promise<void>>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  // By provider session id: at most one outstanding abort for each.
  readonly #runAborts = new Map<string, RunAbort>()
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
  readonly #platform: NodeJS.Platform

  constructor(
    factory: OpenCodeFactory = defaultOpenCodeFactory,
    id: (after?: string) => string = nextOpenCodeMessageId,
    identity: OpenCodeAdapterIdentity = { providerId: "opencode", providerName: "OpenCode" },
    options: OpenCodeAdapterOptions = {},
  ) {
    this.#factory = factory
    this.#id = id
    this.#identity = identity
    this.#platform = options.platform ?? process.platform
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
    await this.#refuseUnownedNames(client, cwd, runtime)
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
      await this.#refuseUnownedNames(client, cwd, runtime)
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
    session.activeTurn = {}
    try {
      await this.#sendPrompt(session, turnId, prompt, runtime, { starts: turnId })
    } catch (error) {
      if (session.activeTurnId === turnId) {
        delete session.activeTurnId
        delete session.activeTurn
      }
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
    // Set before the prompt goes out: its reply can arrive before the answer.
    session.steerTurnIds.set(providerMessageId, turnId)
    await this.#sendPrompt(session, providerMessageId, prompt, session.runtime, { steers: turnId })
    // The server answers a prompt and ends a run independently, so the turn
    // can end while the steer is in flight. The server then runs the
    // accepted steer outside any Domovoi turn, where no tool call is checked:
    // Domovoi aborts that run, waits for the server's answer, and fails the
    // steer (security review rounds 6 and 7 of #687). A prompt for a new turn
    // waits for that abort, and that run's end never ends a later turn, which
    // ends only after its own reply (#turnEndOn).
    if (session.activeTurnId !== turnId) {
      const name = this.#identity.providerName
      const reason = `The ${name} turn ended while the steer was sent, so Domovoi stopped it: ${name} would have run it outside the turn, where Domovoi does not check its tool calls. Send it as a new prompt.`
      // Another turn may hold the slot by now; the abort ends its run too, so
      // that turn fails with the same reason.
      const next = session.activeTurnId
      const stopped = next !== undefined
        ? await this.#stopTurn(session, next, reason)
        : await this.#abortRun(session.threadId, session.cwd, reason).settled
      throw new Error(stopped ? reason : `${reason} ${this.#unconfirmed()}`)
    }
    return { providerMessageId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) return
    // Through the shared abort record: an abort already pending is joined,
    // and the turn fails once the server answers (security review round 8 of
    // #687). A failed or unanswered abort throws, as before, and leaves the
    // turn running unless a stop it joined ends it.
    const name = this.#identity.providerName
    const answered = await this.#abortRun(threadId, session.cwd, `The ${name} turn was interrupted.`, { turnId, ends: "interrupt" }).settled
    if (!answered) throw new Error(`${name} turn interruption failed. ${this.#unconfirmed()}`)
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId)
    const pending = this.#pendingSessionLoads.get(threadId)
    if (!session && !pending) return
    if (pending) pending.cancelled = true
    const cwd = session?.cwd ?? pending!.cwd
    const client = await this.#client()
    const turnId = session?.activeTurnId
    if (session && turnId !== undefined) {
      // Through the shared abort record, joining one already pending (security
      // review round 8 of #687). A failed or unanswered abort throws, as before.
      const name = this.#identity.providerName
      const answered = await this.#abortRun(threadId, cwd, `The ${name} session was stopped.`, { turnId, ends: "hold" }).settled
      if (!answered) throw new Error(`${name} session interruption failed. ${this.#unconfirmed()}`)
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
    if (!pending) throw new ApprovalRequestNotPendingError(requestId)
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
    // A prompt waiting on a stop or an abort is refused (#readyToSend).
    for (const session of [...this.#sessions.values()]) this.#dropSession(session)
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
    let leave!: () => void
    const gone = new Promise<void>((resolve) => { leave = resolve })
    const session: Session = {
      threadId,
      cwd,
      runtime,
      generation: ++this.#nextGeneration,
      assistantMessageTurnIds: new Map(),
      steerTurnIds: new Map(),
      toolPhases: new Map(),
      activity: 0,
      gone,
      leave,
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
    const settles = sessions.map((session) => this.#holdThread(session))
    let outcome: StopOutcome | undefined
    void Promise.all(sessions.map((session) => this.#abortThread(session))).then(async (confirmed) => {
      if (!confirmed.every(Boolean)) {
        await this.#stopServer(this.#unconfirmedStopReason())
        return
      }
      outcome = { rank: 2, error: reason }
      for (const [index, session] of sessions.entries()) {
        if (this.#sessions.get(session.threadId) !== session) continue
        // The session leaves once every stop of it has settled (ThreadStop).
        settles[index]!(outcome, () => {
          if (this.#sessions.get(session.threadId) !== session) return
          this.#forgetSubagents(session.threadId)
          this.#forgetReplies(session.threadId)
          this.#dropSession(session)
        })
      }
      this.#emit({ type: "provider-disconnected", reason })
    }).finally(() => {
      for (const settle of settles) settle(outcome)
    })
  }

  // Registers a thread-wide stop of the session's turn and returns how its
  // owner settles it, once, with its failure or none (security review rounds
  // 11 and 12 of #687). While any stop is registered, the root abort's
  // answer, a read of the server's state and the run's own end do not end
  // the turn, and a prompt waits (#readyToSend). When the last registered
  // owner settles, the turn ends once with the failure first in precedence
  // (StopOutcome); with none, a turn still open is read from the server.
  // Owners never wait for each other. What an owner does with the session
  // once it has settled (`dispose`: unload it, drop it) runs only when the
  // last owner has settled, after the turn ended (security review round 13
  // of #687).
  #holdThread(session: Session): (outcome?: StopOutcome, dispose?: () => void) => void {
    let stop = session.threadStop
    if (!stop) {
      let clear!: () => void
      const cleared = new Promise<void>((resolve) => { clear = resolve })
      stop = { turnId: session.activeTurnId, owners: 0, disposals: [], cleared, clear }
      session.threadStop = stop
    }
    const held = stop
    held.owners += 1
    this.#clearReconcile(session)
    let settled = false
    return (outcome, dispose) => {
      if (settled) return
      settled = true
      this.#recordOutcome(held, outcome)
      held.owners -= 1
      if (dispose) held.disposals.push(dispose)
      // The record ended without this owner (the session was removed for
      // good, as by close): what it would do is done now.
      if (session.threadStop !== held) {
        this.#runDisposals(held)
        return
      }
      if (held.owners > 0) return
      this.#endThreadStop(session, held)
      if (session.activeTurnId !== undefined && this.#sessions.get(session.threadId) === session) this.#scheduleReconcile(session, session.activeTurnId)
    }
  }

  #recordOutcome(stop: ThreadStop, outcome: StopOutcome | undefined): void {
    if (outcome && (!stop.outcome || outcome.rank < stop.outcome.rank)) stop.outcome = outcome
  }

  // Ends the stop record: the turn it concerns, if still open, fails once
  // with the best recorded failure, and then what the owners would do with
  // the session runs. Called when the last owner settles, and when the
  // session is removed for good first (#dropSession).
  #endThreadStop(session: Session, stop: ThreadStop): void {
    if (session.threadStop === stop) delete session.threadStop
    const outcome = stop.outcome
    if (outcome && stop.turnId !== undefined && session.activeTurnId === stop.turnId) {
      this.#complete(session, "failed", outcome.error, outcome.failure)
    }
    stop.clear()
    this.#runDisposals(stop)
  }

  #runDisposals(stop: ThreadStop): void {
    for (const dispose of stop.disposals.splice(0)) dispose()
  }

  // The session leaves the adapter for good: a stop under way ends its turn
  // with what it recorded, whatever owners remain, and a prompt waiting on
  // it is refused (#readyToSend). An ordinary stop owner never calls this
  // while another stop is registered; it hands it to the record as a
  // disposal (#holdThread). This releases waiters only; it does not show
  // that the provider stopped.
  #dropSession(session: Session): void {
    if (session.threadStop) this.#endThreadStop(session, session.threadStop)
    this.#clearReconcile(session)
    if (this.#sessions.get(session.threadId) === session) this.#sessions.delete(session.threadId)
    session.leave()
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
  async #refuseUnownedNames(client: OpenCodeClient, cwd: string, runtime: Runtime): Promise<ToolCatalog> {
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
      // Two ids the server's rules would read as one are a duplicate.
      const listed = new Set<string>()
      for (const id of ids) {
        if ([...listed].some((seen) => sameRuleName(seen, id, this.#platform))) throw this.#unownedTool(id)
        listed.add(id)
      }
      const states = serverStatesOf(servers)
      catalog = { servers: Object.keys(servers), serverStates: states, checkedStates: states, toolIds: listed }
    } catch (error) {
      if (error instanceof UnownedToolError) throw error
      throw unreadable
    }
    // The catalog is published to the directory only once every check below
    // has passed (security review round 4 of #687).
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
    // A tool id the server's rules would read as an allowed permission (in
    // any case on Windows) must be exactly one of the server's own ids.
    const ownToolIds = new Set(this.#identity.builtInToolIds ?? openCodeBuiltInToolIds)
    const allowed = [...this.#identity.allowedPermissions ?? openCodeAllowedPermissions]
    for (const id of catalog.toolIds) {
      if (ownToolIds.has(id)) continue
      if (allowed.some((permission) => sameRuleName(permission, id, this.#platform))) throw this.#unownedTool(id)
    }
    // Config this adapter does not see, an agent or mode block of the
    // person's, an organization's or a managed config, can still leave an
    // agent allowing a tool that is not the server's own (security review
    // rounds 2 and 3 of #687). The agents' merged rules, as the server will
    // judge calls, are checked by shape (unnamedToolAllow), for every agent
    // the session can reach from the primary agent it runs (reachableAgents).
    const primary = (this.#identity.agentName ?? ((agent: string) => agent))(openCodeAgentFor(runtime))
    const reachable = reachableAgents(agents, primary, this.#platform)
    if (reachable === undefined) {
      throw new UnownedToolError(`${name} does not list its ${primary} agent, so Domovoi cannot tell whether a tool could run there without approval.`)
    }
    const builtIns = this.#identity.builtInPermissions ?? openCodeBuiltInPermissions
    const config = "your own configuration (an agent or mode block, or the top-level permission block) or an organization's or managed config"
    for (const record of reachable) {
      const rules = mergedRules(record.permission)
      if (rules === undefined) {
        throw new UnownedToolError(`${name}'s ${record.name} agent has a rule Domovoi cannot read, so it cannot tell whether a tool could run there without approval. Check ${name}'s ${config}.`)
      }
      const opened = unnamedToolAllow(rules, builtIns)
      if (opened?.kind === "no-catch-all") {
        throw new UnownedToolError(
          `${name}'s ${record.name} agent does not ask before a tool that is not ${name}'s own, so such a tool could run there without approval. `
          + `A "*" rule in ${config} allows it; remove that rule to use ${name} here.`,
        )
      }
      if (opened?.kind === "allow") {
        throw new UnownedToolError(
          `${name}'s ${record.name} agent allows "${opened.permission}", which is not one of ${name}'s own tools, so a tool could run there without approval. `
          + `Remove that rule from ${config} to use ${name} here.`,
        )
      }
    }
    this.#catalogs.set(cwd, catalog)
    return catalog
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
        if (servers && this.#catalogs.get(cwd) === catalog) {
          this.#catalogs.set(cwd, { ...catalog, servers: Object.keys(servers), serverStates: serverStatesOf(servers) })
        }
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
    this.#forgetReplies(session.threadId)
    this.#dropSession(session)
    this.#runAborts.delete(session.threadId)
    const directory = this.#directories.get(session.cwd)
    if (!directory) return
    directory.threadIds.delete(session.threadId)
    if (directory.threadIds.size > 0) return
    directory.controller.abort()
    this.#directories.delete(session.cwd)
  }

  // Waits for an abort pending on the thread's session, so a prompt never
  // goes out while the server is still taking one (security review round 7
  // of #687). An abort the server did not answer fails the prompt with the
  // stop's reason, and a prompt whose turn ended meanwhile is not sent.
  //
  // Every wait is followed by every check again (security review round 12
  // of #687): a thread-wide stop registered while this waited on an abort
  // holds the prompt too (#holdThread), and a session that is unloaded or
  // dropped, or an adapter that closes, refuses it rather than leave it
  // waiting. Being let go says nothing about whether the provider stopped.
  async #readyToSend(session: Session, turnId: string): Promise<void> {
    for (;;) {
      if (this.#closed) throw new Error(`${this.#identity.providerName} adapter closed`)
      if (session.activeTurnId !== turnId || this.#sessions.get(session.threadId) !== session) {
        throw new Error(`${this.#identity.providerName} turn is no longer active`)
      }
      const stop = session.threadStop
      if (stop) {
        await Promise.race([stop.cleared, session.gone])
        continue
      }
      const record = this.#runAborts.get(session.threadId)
      if (record?.pending) {
        const answered = await Promise.race([record.settled, session.gone.then(() => true)])
        if (!answered) throw new Error(`${record.reason} ${this.#unconfirmed()} Domovoi did not send this prompt.`)
        continue
      }
      return
    }
  }

  // `turn` is the turn the prompt belongs to: its own id when it starts the
  // turn, the turn it steers otherwise.
  async #sendPrompt(
    session: Session,
    messageId: string,
    prompt: string,
    runtime: Runtime,
    turn: { starts: string } | { steers: string },
  ): Promise<void> {
    const startsTurn = "starts" in turn
    const turnId = startsTurn ? turn.starts : turn.steers
    await this.#readyToSend(session, turnId)
    await this.#refuseHeldBackRepositoryFiles(session.cwd)
    const client = await this.#client()
    const model = openCodeModel(runtime.model)
    const system = await projectInstructions(session.cwd, "opencode")
    // Last before the prompt goes out, after everything else it waits on, so
    // a tool server added meanwhile is seen (security review round 3 of #687).
    const checked = await this.#refuseUnownedNames(client, session.cwd, runtime)
    // An abort started during the reads above (the turn was stopped) is
    // waited for too; then the turn has ended and nothing is sent.
    await this.#readyToSend(session, turnId)
    // What this turn's tool calls are held to until it ends, whatever another
    // session's check publishes to the directory later. Only the prompt that
    // starts the turn sets it: a steer runs its own check above but leaves
    // the turn's snapshot as it was (security review round 5 of #687).
    if (startsTurn) session.checkedCatalog = { turnId: messageId, catalog: checked }
    session.activity += 1
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
    // A tool call starting (pending or running). A completed or failed tool's
    // report is a late one, such as the server's cleanup of a run it
    // stopped, and starts nothing (security review round 7 of #687).
    const part = event.type === "message.part.updated" ? asRecord(properties.part) : undefined
    const toolStatus = part?.type === "tool" ? asRecord(part.state)?.status : undefined
    const toolStarts = toolStatus === "pending" || toolStatus === "running"
    const permissionType = event.type === "permission.updated" || event.type === "permission.asked" ? event.type : undefined
    const permission = permissionType !== undefined
    if (!session || session.cwd !== cwd) {
      // A subagent started while its thread had no turn is never linked, and
      // runs outside any turn: an approval it asks for is refused, and that
      // or a tool call it starts aborts it.
      const neverLinked = this.#subagents.neverLinkedThread(sessionId)
      if ((toolStarts || permission) && neverLinked !== undefined && this.#sessions.get(neverLinked)?.cwd === cwd) {
        this.#refuseUnwatched(event.type, properties, sessionId, cwd)
        this.#abortUnwatched(sessionId, cwd)
      }
      return
    }
    // A subagent outlives nothing: once the turn that started it has ended,
    // whatever it still sends is dropped rather than attached to a later turn,
    // an approval it asks for is refused at once, with no card, and that or
    // a tool call it starts aborts it.
    if (subagentTurn && session.activeTurnId !== subagentTurn.turnId) {
      if (permissionType !== undefined) {
        const request = permissionRequest(permissionType, properties, this.#identity.providerName)
        if (request) {
          this.#respond(
            { providerSessionId: sessionId, cwd, permissionId: request.permissionId, subagentTurn, generation: session.generation },
            "reject",
            ++this.#nextApprovalId,
          )
        }
      }
      if (toolStarts || permission) this.#abortUnwatched(sessionId, cwd)
      return
    }
    // Anything but an end (idle, error, an idle status) is activity that a
    // read of the server's state did not see (#reconcile). A subagent whose
    // turn has ended was handled above: its events are not the current
    // turn's activity (security review round 11 of #687).
    const ends = event.type === "session.idle" || event.type === "session.error"
      || (event.type === "session.status" && asRecord(properties.status)?.type === "idle")
    if (!ends) session.activity += 1
    if (event.type === "message.updated") {
      const info = asRecord(properties.info)
      if (!subagent && info) this.#trackTurnMessage(session, info)
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
    if (!turnId) {
      // No turn is active, so a run that starts a tool call or asks for an
      // approval is one the server started outside any turn: the approval is
      // refused and the run aborted (security review rounds 6 and 7 of #687).
      if (toolStarts || permission) {
        this.#refuseUnwatched(event.type, properties, sessionId, cwd)
        this.#abortUnwatched(sessionId, cwd)
      }
      return
    }
    if (event.type === "message.part.updated") {
      if (typeof part?.messageID !== "string") return
      // A tool call in a message the adapter did not see is still checked,
      // as the active turn's.
      const parentTurnId = session.assistantMessageTurnIds.get(part.messageID) ?? (part.type === "tool" ? turnId : undefined)
      if (parentTurnId === undefined) return
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
    if (event.type === "session.error") {
      const turn = session.activeTurn
      // Before the turn's own messages, an error is an earlier run's.
      if (turn?.seen) turn.error = errorMessage(asRecord(properties.error), this.#identity.providerName)
      // An error never ends a turn by itself: it can come after the run's
      // last idle, or before the prompt was recorded (security review round
      // 9 of #687). The server's own state settles it.
      if (session.activeTurnId !== undefined) this.#scheduleReconcile(session, session.activeTurnId)
      return
    }
    if (event.type === "session.idle") {
      this.#turnEndOn(session)
      // An idle that did not end the turn: an earlier run's, or one whose
      // end the events do not show (#reconcile).
      if (session.activeTurnId !== undefined) this.#scheduleReconcile(session, session.activeTurnId)
    }
  }

  // A tool server added while a turn runs (the server's POST /mcp, which
  // emits no event) can register a tool named like a built-in permission the
  // embedded config allows, and that tool would run with no card (security
  // review round 2 of #687). Every tool call the turn makes, a steer's
  // included, is checked as it first appears: a tool the catalog checked
  // before the turn's first prompt did not hold aborts the turn, and so does
  // a change in the directory's tool servers, read again on each call, or a
  // read that fails. Every prompt reads the catalog again before it is sent
  // and refuses a server that could take such a name, but only the turn's
  // first prompt sets what its calls are held to.
  //
  // This is a stated limit, not a gate (rulings Q258 and Q262, security
  // review round 4 of #687). The server reports a tool call only once it has
  // started it, so the call that shows the change can already have run, and
  // the abort reaches a running tool only if that tool honors cancellation;
  // nothing here undoes what it did. The check holds the rest of the turn.
  #watchToolCall(session: Session, turnId: string, tool: string): void {
    // A snapshot from another turn holds nothing for this one.
    const catalog = session.checkedCatalog?.turnId === turnId ? session.checkedCatalog.catalog : undefined
    const known = catalog !== undefined && (catalog.toolIds.has(tool) || serverInjectedTools.has(tool)
      || [...catalog.checkedStates.keys()].some((server) => tool.startsWith(`${openCodeToolPrefixName(server)}_`)))
    if (!known) {
      void this.#stopTurn(session, turnId, `${this.#identity.providerName} called a tool named "${tool}" that was not among its tools when the turn started, `
        + `so Domovoi aborted the turn: a tool added during a turn could run without approval. ${abortLimit} Send the prompt again to check the tools first.`)
      return
    }
    void this.#checkToolServers(session, turnId, catalog)
  }

  async #checkToolServers(session: Session, turnId: string, catalog: ToolCatalog): Promise<void> {
    const name = this.#identity.providerName
    let states: Map<string, string> | undefined
    try {
      const client = this.#runtime?.client
      const answer = client?.mcp
        ? asRecord(unwrap(await client.mcp.status({
          query: { directory: session.cwd },
          signal: AbortSignal.timeout(catalogReadTimeoutMs * 5),
          throwOnError: true,
        }), `${name} tool server status`))
        : undefined
      states = answer ? serverStatesOf(answer) : undefined
    } catch {
      states = undefined
    }
    if (states === undefined) {
      void this.#stopTurn(session, turnId, `Domovoi could not read ${name}'s tool servers during the turn, so it aborted the turn: a tool added during a turn could run without approval. ${abortLimit} Send the prompt again.`)
      return
    }
    const checked = catalog.checkedStates
    const changed = [...new Set([...states.keys(), ...checked.keys()])].filter((server) => states.get(server) !== checked.get(server))
    if (changed.length > 0) {
      void this.#stopTurn(session, turnId, `${name}'s tool servers changed during the turn (${changed.map((server) => `"${server}"`).join(", ")}), `
        + `so Domovoi aborted the turn: a tool added during a turn could run without approval. ${abortLimit} Send the prompt again to check the tools first.`)
    }
  }

  // Aborts the turn's run; the abort's answer, not the run's end, ends the
  // turn as failed with `reason`, so the turn is not reported over before
  // the server has taken the abort. An abort not answered in time is
  // reported in the reason. An answered abort does not show that a tool
  // already running stopped: that tool may not honor it (#watchToolCall).
  // Resolves true once the server answered the abort, false if it did not. A
  // stop already under way is joined: the caller waits for its answer
  // (security review rounds 7 and 8 of #687). A turn no longer active
  // resolves true at once.
  async #stopTurn(session: Session, turnId: string, reason: string): Promise<boolean> {
    if (session.activeTurnId !== turnId || this.#sessions.get(session.threadId) !== session) return true
    return this.#abortRun(session.threadId, session.cwd, reason, { turnId, ends: "stop" }).settled
  }

  #unconfirmed(): string {
    return `Domovoi could not confirm that ${this.#identity.providerName} stopped the run.`
  }

  // Aborts a provider session's run: the thread's, or a subagent's. Every
  // abort the adapter sends goes through here. The abort is recorded before
  // it is sent, and a second one while it is pending joins it rather than
  // sending another (security review rounds 7 and 8 of #687). When it
  // settles, the record goes, and the thread's active turn ends as the
  // record's entry for it says (RunAbort).
  #abortRun(
    providerSessionId: string,
    cwd: string,
    reason: string,
    turn?: { turnId: string; ends: "stop" | "interrupt" | "hold" },
  ): RunAbort {
    const pending = this.#runAborts.get(providerSessionId)
    const record: RunAbort = pending ?? { turns: new Map(), reason, settled: Promise.resolve(false), pending: true }
    if (turn) {
      const rank = { hold: 0, interrupt: 1, stop: 2 } as const
      const current = record.turns.get(turn.turnId)
      if (!current || rank[turn.ends] > rank[current.ends]) record.turns.set(turn.turnId, { ends: turn.ends, reason })
      // A prompt waiting on the abort fails with the stop's reason.
      if (turn.ends === "stop") record.reason = reason
    }
    // A read of the thread's state already scheduled or under way predates
    // this abort, so it no longer counts, even if the abort settles before
    // the read returns; the abort's settling schedules a fresh one (security
    // review round 11 of #687).
    const owner = this.#sessions.get(providerSessionId)
    if (owner) this.#clearReconcile(owner)
    if (pending) return pending
    this.#runAborts.set(providerSessionId, record)
    record.settled = this.#sendAbort(providerSessionId, cwd).then((answered) => {
      record.pending = false
      if (this.#runAborts.get(providerSessionId) === record) this.#runAborts.delete(providerSessionId)
      const session = this.#sessions.get(providerSessionId)
      const active = session?.activeTurnId
      if (!session || active === undefined) return answered
      // A thread-wide stop under way ends the turn with its own failure,
      // whatever stop or interrupt it joined (#holdThread).
      const entry = record.turns.get(active)
      if (!session.threadStop && entry && (entry.ends === "stop" || (entry.ends === "interrupt" && answered))) {
        this.#complete(session, "failed", answered ? entry.reason : `${entry.reason} ${this.#unconfirmed()}`)
      }
      // The turn is still open: an interrupt or a thread stop whose abort
      // failed or went unanswered, a thread stop whose deletion may yet fail,
      // or an abort that made a read stale. What the run published meanwhile
      // is read back from the server (security review rounds 9 and 11 of
      // #687, ruling Q294). A thread-wide stop under way reads it, if need
      // be, once its last owner settles.
      if (session.activeTurnId === active && !session.threadStop) this.#scheduleReconcile(session, active)
      return answered
    })
    return record
  }

  // True once the server answers the abort. False when it refuses, or does
  // not answer within ten seconds: the servers' own clients set no request
  // timeout, so without this bound a prompt waiting on the abort would wait
  // for ever (security review round 8 of #687).
  async #sendAbort(providerSessionId: string, cwd: string): Promise<boolean> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const unanswered = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(false)
      }, abortAnswerTimeoutMs)
    })
    const answer = (async () => {
      try {
        // The running server's client: an abort never starts a server.
        const client = this.#runtime?.client
        if (!client) throw new Error(`${this.#identity.providerName} server is not running`)
        unwrap(await client.session.abort({
          path: { id: providerSessionId },
          query: { directory: cwd },
          signal: controller.signal,
          throwOnError: true,
        }), `${this.#identity.providerName} turn interruption`)
        return true
      } catch (error) {
        if (!controller.signal.aborted) console.error(`Domovoi could not stop a ${this.#identity.providerName} turn`, error)
        return false
      }
    })()
    try {
      const answered = await Promise.race([answer, unanswered])
      if (!answered && controller.signal.aborted) console.error(`${this.#identity.providerName} did not answer an abort within ${abortAnswerTimeoutMs / 1000} seconds`)
      return answered
    } finally {
      clearTimeout(timer)
    }
  }

  // The active turn's progress, by message identity (security review round
  // 8 of #687, ruling Q287). OpenCode 1.18.32/1.18.33 and Kilo 7.8.1 publish
  // `message.updated` with `properties.info`: a prompt's user message keeps
  // the `id` Domovoi sent as `messageID`; each assistant message the run
  // makes has `role: "assistant"` and `parentID`, the id of the user message
  // it replies to (SessionPrompt.runLoop: `parentID: lastUser.id`, so a
  // steer's reply names the steer), and is published again with
  // `time.completed` once it ends, with `error` set when it failed
  // (SessionProcessor cleanup and halt). Events from before the turn's own
  // messages are an earlier run's: the server publishes an aborted run's
  // events before it answers the abort, and no prompt goes out while an
  // abort is pending (#readyToSend).
  #trackTurnMessage(session: Session, info: Record<string, unknown>): void {
    const turnId = session.activeTurnId
    const turn = session.activeTurn
    if (turnId === undefined || !turn) return
    const parent = typeof info.parentID === "string" ? info.parentID : undefined
    const ownReply = info.role === "assistant" && parent !== undefined && (parent === turnId || session.steerTurnIds.get(parent) === turnId)
    if (info.id === turnId || ownReply) turn.seen = true
    if (!ownReply) return
    const time = asRecord(info.time)
    const failed = asRecord(info.error)
    const done = typeof time?.completed === "number" || failed !== undefined
    // A reply that has not ended yet: the run goes on, so an error before it
    // no longer decides how the turn ends.
    if (!done) delete turn.error
    turn.reply = { done, ...(failed ? { error: errorMessage(failed, this.#identity.providerName) } : {}) }
  }

  // An idle ends the active turn only after the turn's own latest reply has
  // completed or failed, or, when the run failed before any reply (an
  // unknown agent, say), after an error that followed the turn's own prompt.
  // An idle or error before the turn's own messages never ends it. A turn an
  // abort under way concerns ends on the abort's answer instead (#abortRun).
  // The servers publish an aborted run's end as an error and one or two
  // idles (the processor's halt, then the runner's cancel), so the number of
  // idles decides nothing (security review round 8 of #687, ruling Q287).
  #turnEndOn(session: Session): void {
    const turnId = session.activeTurnId
    const turn = session.activeTurn
    if (turnId === undefined || !turn?.seen) return
    if (this.#runAborts.get(session.threadId)?.turns.has(turnId) || session.threadStop) return
    if (turn.reply ? !turn.reply.done : turn.error === undefined) return
    const error = turn.reply?.error ?? turn.error
    if (error === undefined) this.#complete(session, "completed")
    else this.#complete(session, "failed", error)
  }

  // Schedules a read of the server's own state for the active turn
  // (#reconcile). A read already scheduled for the turn is kept, so repeats
  // coalesce.
  #scheduleReconcile(session: Session, turnId: string, delay: number = reconcileDelayMs): void {
    if (session.activeTurnId !== turnId || this.#closed) return
    if (session.reconcile?.turnId === turnId) return
    this.#clearReconcile(session)
    session.reconcile = {
      turnId,
      retries: 0,
      timer: setTimeout(() => { void this.#reconcile(session, turnId) }, delay),
    }
  }

  #clearReconcile(session: Session): void {
    if (session.reconcile) clearTimeout(session.reconcile.timer)
    delete session.reconcile
  }

  // Settles a turn the events left open from the server's own state
  // (security review round 9 of #687, ruling Q294). The events cannot always
  // end it: automatic compaction before the first reply makes user messages
  // of the server's own, and the replies name those as their parents; the
  // prompt handler publishes a setup failure's error after the run's last
  // idle, or before the prompt is recorded; a reply's setup can fail without
  // completing it; and an end that came while an abort that then failed was
  // pending ends nothing. An idle or error that ended no turn, or such an
  // abort, schedules this read two seconds later. A prompt the idle session
  // does not hold yet, or holds with no reply and no error seen, is read
  // again until the bound before the turn fails: the server can still be
  // preparing it.
  //
  // A session the server reports busy settles nothing: a run is going, and
  // its own end will be seen, so an earlier run's idle cannot end a later
  // turn this way. With the session idle, the turn ends by its prompt's
  // record (its user message, whose id Domovoi chose) and the newest
  // assistant message created after it, whatever that message's parent, so
  // compaction and continuation replies count. Tool calls are still held to
  // the turn by parent identity alone (#receiveTool).
  async #reconcile(session: Session, turnId: string): Promise<void> {
    const current = () => this.#sessions.get(session.threadId) === session && session.activeTurnId === turnId && !this.#closed
    const scheduled = session.reconcile
    if (!scheduled || scheduled.turnId !== turnId) return
    if (!current()) {
      this.#clearReconcile(session)
      return
    }
    // A pending abort holds the turn; its settling schedules this again.
    // A pending abort concerning the turn, or a thread-wide stop under way,
    // holds it; its settling, or its last owner's, schedules this again.
    const held = () => this.#runAborts.get(session.threadId)?.turns.has(turnId) === true || session.threadStop !== undefined
    if (held()) {
      this.#clearReconcile(session)
      return
    }
    const name = this.#identity.providerName
    const activity = session.activity
    let outcome: TurnOutcome | "busy" | { inconclusive: string }
    try {
      outcome = await this.#readTurnOutcome(session, turnId)
    } catch (error) {
      console.error(`Domovoi could not read how a ${name} run ended`, error)
      outcome = { inconclusive: `Domovoi could not read ${name}'s session, so it could not confirm how the run ended, and ended the turn.` }
    }
    if (session.reconcile !== scheduled) return
    if (!current()) {
      this.#clearReconcile(session)
      return
    }
    // Rechecked after the read, before anything is retried or applied
    // (security review round 10 of #687): an abort that started during the
    // read (a stop, an interrupt, a thread stop) holds the turn, and its
    // settling ends it or schedules this again.
    if (held()) {
      this.#clearReconcile(session)
      return
    }
    // The session did something the read may not show: read it afresh.
    if (session.activity !== activity) {
      this.#clearReconcile(session)
      this.#scheduleReconcile(session, turnId)
      return
    }
    if (outcome === "busy") {
      this.#clearReconcile(session)
      return
    }
    if ("inconclusive" in outcome) {
      // A failed read, or an idle session that does not yet show the run (a
      // prompt the server is still preparing, or a run not yet started):
      // read again, up to the bound, then end the turn with the reason.
      const delay = reconcileRetryDelaysMs[scheduled.retries]
      if (delay !== undefined) {
        scheduled.retries += 1
        scheduled.timer = setTimeout(() => { void this.#reconcile(session, turnId) }, delay)
        return
      }
      this.#clearReconcile(session)
      this.#complete(session, "failed", outcome.inconclusive)
      return
    }
    this.#clearReconcile(session)
    if (outcome.status === "completed") this.#complete(session, "completed")
    else this.#complete(session, "failed", outcome.error)
  }

  // The server's account of how the turn's run ended: "busy" while a run is
  // going, inconclusive (with the reason to end the turn once that holds to
  // the bound) when the idle session does not hold the turn's prompt, or
  // holds it with no reply and no error was seen. Throws when a read fails.
  async #readTurnOutcome(session: Session, turnId: string): Promise<TurnOutcome | "busy" | { inconclusive: string }> {
    // The running server's client: a read never starts a server.
    const client = this.#runtime?.client
    const name = this.#identity.providerName
    if (!client) throw new Error(`${name} server is not running`)
    const busy = async () => {
      const statuses = asRecord(unwrap(await client.session.status({
        query: { directory: session.cwd },
        signal: AbortSignal.timeout(reconcileReadTimeoutMs),
        throwOnError: true,
      }), `${name} session status`))
      if (!statuses) throw new Error(`${name} answered the session status with something else`)
      const status = asRecord(statuses[session.threadId])?.type
      return status !== undefined && status !== "idle"
    }
    if (await busy()) return "busy"
    const messages = await this.#messagesFromPrompt(client, session, turnId)
    // The status and the history are separate reads, so the session can
    // turn busy between them: the history counts only if it is idle after
    // it too (security review round 10 of #687).
    if (await busy()) return "busy"
    if (messages === undefined) return { inconclusive: `${name} never recorded this turn's prompt, and its session is idle, so Domovoi ended the turn.` }
    // Ordered as the servers order messages, by time.created and then id
    // (opencode 1.18.33 and kilo 7.8.1 session/message-v2.ts isAfter), so an
    // assistant from the prompt's millisecond with an earlier id is not
    // after it, and the order pages come in decides nothing.
    let newest: Record<string, unknown> | undefined
    for (const info of messages.others) {
      if (info.role !== "assistant" || !isAfter(info, messages.prompt)) continue
      if (!newest || isAfter(info, newest)) newest = info
    }
    if (!newest) {
      // The last session error seen after the turn's own prompt says why.
      // Without one, the run may not have started yet.
      const error = session.activeTurn?.error
      return error !== undefined
        ? { status: "failed", error }
        : { inconclusive: `${name} ended the run without a reply, so Domovoi ended the turn.` }
    }
    const failure = asRecord(newest.error)
    if (failure) return { status: "failed", error: errorMessage(failure, name) }
    if (typeof asRecord(newest.time)?.completed !== "number") {
      return { status: "failed", error: `${name} left the turn's reply unfinished, and its session is idle, so Domovoi ended the turn.` }
    }
    return { status: "completed" }
  }

  // The turn's prompt and the session's other messages from its newest page
  // back to the prompt (GET /session/{id}/message, SDK `session.messages`,
  // paged backwards as for a resume and within the same bounds). Undefined
  // when the history does not hold the prompt.
  async #messagesFromPrompt(
    client: OpenCodeClient,
    session: Session,
    turnId: string,
  ): Promise<{ prompt: Record<string, unknown>; others: Array<Record<string, unknown>> } | undefined> {
    const signal = AbortSignal.timeout(reconcileReadTimeoutMs)
    const collected: Array<Record<string, unknown>> = []
    const infosOf = (result: OpenCodeResult<unknown>) => this.#historyMessages(result).flatMap((message) => {
      const info = asRecord(asRecord(message)?.info)
      return info ? [info] : []
    })
    const found = () => {
      const prompt = collected.find((info) => info.id === turnId)
      return prompt ? { prompt, others: collected.filter((info) => info !== prompt) } : undefined
    }
    let before: string | undefined
    for (let page = 0; page < maximumHistoryPages; page += 1) {
      const result = await client.session.messages({
        path: { id: session.threadId },
        query: { directory: session.cwd, limit: historyPageSize, ...(before === undefined ? {} : { before }) },
        signal,
        throwOnError: true,
      })
      const infos = infosOf(result)
      collected.push(...infos)
      const hit = found()
      if (hit) return hit
      const next = result.response?.headers.get("x-next-cursor") ?? undefined
      if (!next) {
        if (infos.length < historyPageSize) return undefined
        // A full page without a cursor: the whole history at once, as a
        // resume reads it (#greatestInWholeHistory).
        collected.splice(0, collected.length, ...infosOf(await client.session.messages({
          path: { id: session.threadId },
          query: { directory: session.cwd },
          signal,
          throwOnError: true,
        })))
        return found()
      }
      before = next
    }
    return undefined
  }

  // A run the server started outside any Domovoi turn, such as a steer it
  // accepted after the turn ended, or a subagent of one, calls tools no
  // turn checks. A tool call it starts or an approval it asks for aborts it
  // (security review rounds 6 and 7 of #687); a report of a tool that has
  // finished does not. A pending abort is joined, not sent again.
  #abortUnwatched(providerSessionId: string, cwd: string): void {
    const name = this.#identity.providerName
    void this.#abortRun(providerSessionId, cwd, `${name} ran a prompt outside any Domovoi turn, so Domovoi stopped it: Domovoi does not check its tool calls.`)
  }

  // An approval asked for outside any turn is refused, with no card.
  #refuseUnwatched(type: string, properties: Record<string, unknown>, providerSessionId: string, cwd: string): void {
    if (type !== "permission.updated" && type !== "permission.asked") return
    const request = permissionRequest(type, properties, this.#identity.providerName)
    if (request) this.#respond({ providerSessionId, cwd, permissionId: request.permissionId }, "reject", ++this.#nextApprovalId)
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
    // The daemon's card for the answered request, if it still showed one,
    // carries the id its approval-requested event gave it.
    let answered: number | undefined
    for (const [id, pending] of this.#pendingApprovals) {
      if (pending.providerSessionId !== sessionId || pending.permissionId !== requestId) continue
      answered = id
      this.#pendingApprovals.delete(id)
    }
    for (const [id, pending] of this.#failedRefusals) {
      if (pending.providerSessionId === sessionId && pending.permissionId === requestId) this.#failedRefusals.delete(id)
    }
    this.#refusePendingFor(session.threadId)
    const settle = this.#holdThread(session)
    const outcome: StopOutcome = { rank: 0, error: approvalAnsweredElsewhere.message, failure: approvalAnsweredElsewhere }
    void this.#abortThread(session, sessionId).then(async (confirmed) => {
      // The turn ends with the best failure, and the thread is unloaded, once
      // every stop of it has settled: now, or when the last other one does
      // (ThreadStop, security review round 13 of #687).
      settle(outcome, () => {
        if (this.#sessions.get(session.threadId) === session) this.#unloadSession(session)
      })
      this.#emit({
        type: "approval-answered-elsewhere",
        threadId: session.threadId,
        ...(turnId ? { turnId } : {}),
        permissionId: requestId,
        ...(answered === undefined ? {} : { requestId: answered }),
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
    }).finally(() => settle(outcome))
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
    const settle = this.#holdThread(session)
    const outcome: StopOutcome = {
      rank: 1,
      error: `${name} asked for an approval through a permission interface Domovoi does not answer, so Domovoi stopped the turn`,
    }
    void this.#abortThread(session, sessionId).then(async (confirmed) => {
      if (!confirmed) {
        await this.#stopServer(this.#unconfirmedStopReason())
        return
      }
      settle(outcome)
    }).finally(() => settle(outcome))
  }

  // Aborts the thread's run and every subagent run it is known to have, and
  // resolves true only when the provider confirmed each abort in time. Each
  // abort goes through the shared record (#abortRun), so one already pending
  // for a session is joined, and the thread's turn is held while it is
  // pending: the caller ends it (security review round 10 of #687).
  async #abortThread(session: Session, ...more: string[]): Promise<boolean> {
    if (!this.#runtime) return false
    const ids = new Set([session.threadId, ...more, ...this.#subagents.sessionsOf(session.threadId)])
    const reason = `The ${this.#identity.providerName} session was stopped.`
    const turnId = session.activeTurnId
    const answers = await Promise.all([...ids].map((id) => this.#abortRun(
      id,
      session.cwd,
      reason,
      id === session.threadId && turnId !== undefined ? { turnId, ends: "hold" } : undefined,
    ).settled))
    return answers.every(Boolean)
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
    for (const session of [...this.#sessions.values()]) {
      const stop = session.threadStop
      if (stop && stop.owners > 0) {
        // A thread-wide stop still has owners: the session stays until the
        // last of them settles, and the turn then ends once with the best
        // failure, this server stop's reason only if none settled with one
        // (StopOutcome, security review round 13 of #687).
        this.#recordOutcome(stop, { rank: 3, error: reason })
        stop.disposals.push(() => this.#dropSession(session))
        continue
      }
      // A thread-wide stop that already settled with its failure keeps it
      // (StopOutcome precedence); otherwise the turn fails with this reason.
      const recorded = stop?.outcome
      if (recorded) this.#complete(session, "failed", recorded.error, recorded.failure)
      else this.#complete(session, "failed", reason)
      this.#dropSession(session)
    }
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
  // The wait for that confirmation is bounded (security review round 12 of
  // #687): on Windows the tree kill has no deadline of its own. A stop not
  // confirmed in time counts as unconfirmed, so the server stays recorded
  // and no other server starts; the next message stops it again.
  #retire(server: OpenCodeServer): Promise<boolean> {
    this.#retiredServer = server
    const name = this.#identity.providerName
    this.#retiring ??= settlesWithin(
      server.stop(),
      serverStopConfirmMs,
      `${name} server stop was not confirmed within ${serverStopConfirmMs / 1000} seconds`,
    ).catch(() => false).then((stopped) => {
      if (stopped && this.#retiredServer === server) this.#retiredServer = undefined
    }).finally(() => {
      this.#retiring = undefined
    })
    return this.#retiring.then(() => this.#retiredServer !== server)
  }

  // Ending the programs alone is not always enough: on Windows a tree that
  // could not be confirmed stays unconfirmed, and only a restart, which
  // forgets the stopped server, clears it (Codex review of #691, round 3).
  #retiredServerRefusal(server: OpenCodeServer): string {
    const name = this.#identity.providerName
    const kind = server.processKind ?? "group"
    const group = server.processGroup === undefined ? "" : ` (process ${kind} ${server.processGroup})`
    return `Domovoi could not confirm that the earlier ${name} server and the programs it started have ended, `
      + `so it starts no other ${name} server. Each new message checks again. To continue sooner, end those `
      + `programs${group}, then restart Domovoi.`
  }

  #receiveTool(session: Session, turnId: string, part: Record<string, unknown>): void {
    const callId = typeof part.callID === "string" ? part.callID : undefined
    const tool = typeof part.tool === "string" ? part.tool : undefined
    const state = asRecord(part.state)
    if (!callId || !tool || !state || typeof state.status !== "string") return
    // Call ids are unique within a provider session only, and a thread's
    // subagents report here too (security review round 3 of #687).
    const phaseKey = `${typeof part.sessionID === "string" ? part.sessionID : session.threadId}\u0000${callId}`
    if (session.toolPhases.get(phaseKey) === state.status) return
    // Only a call starting (pending, running) is checked. A finished call's
    // report (completed, error), such as the server's cleanup of a run it
    // stopped, keeps its output below but never aborts (security review
    // round 8 of #687).
    if (!session.toolPhases.has(phaseKey) && (state.status === "pending" || state.status === "running")) {
      // A steer's reply names the steer as its parent; its calls are the
      // turn's (security review round 6 of #687).
      const logicalTurnId = session.steerTurnIds.get(turnId) ?? turnId
      if (logicalTurnId === session.activeTurnId) this.#watchToolCall(session, logicalTurnId, tool)
      else {
        // A call that starts in a message of no active turn or steer.
        void this.#stopTurn(session, session.activeTurnId!, `${this.#identity.providerName} called a tool named "${tool}" outside the active turn, `
          + `so Domovoi aborted the turn: Domovoi does not check such a call. ${abortLimit} Send the prompt again.`)
      }
    }
    session.toolPhases.set(phaseKey, state.status)
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
    delete session.activeTurnId
    delete session.activeTurn
    this.#clearReconcile(session)
    session.toolPhases.clear()
    session.steerTurnIds.clear()
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

// How a turn's run ended, read from the server (#reconcile).
type TurnOutcome = { status: "completed" } | { status: "failed"; error: string }

// A message's `time.created`, in milliseconds, when it has one.
function createdAt(info: Record<string, unknown>): number | undefined {
  const created = asRecord(info.time)?.created
  return typeof created === "number" ? created : undefined
}

// Whether a message comes after another in the servers' order: by
// time.created, then by id (opencode 1.18.33 and kilo 7.8.1
// session/message-v2.ts isAfter). A message without a time is ordered by id.
function isAfter(info: Record<string, unknown>, other: Record<string, unknown>): boolean {
  const created = createdAt(info)
  const otherCreated = createdAt(other)
  if (created !== undefined && otherCreated !== undefined && created !== otherCreated) return created > otherCreated
  return typeof info.id === "string" && typeof other.id === "string" && info.id > other.id
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

// The OpenCode releases the permission names, tool ids and rule shapes here
// were read from and that passed the live contract (embedded-version.ts).
export const testedOpenCode: TestedVersion = { command: "opencode", providerName: "OpenCode", tested: ["1.18.32", "1.18.33"] }

const defaultOpenCodeFactory: OpenCodeFactory = async () => {
  await requireTestedVersion(testedOpenCode)
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
