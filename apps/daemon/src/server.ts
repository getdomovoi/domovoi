import { createServer, type Server as HttpServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { arch, homedir, hostname, platform, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import {
  boundedClientThread,
  canonicalBase64DecodedByteLength,
  type MachineCapability,
  createEmptyWorkspace,
  daemonAuthenticationErrorCode,
  sourcePreflight,
  transferPreflight,
  type TransferReceipt,
  machineCredentialMissingErrorCode,
  daemonShuttingDownErrorCode,
  demoWorkspace,
  maximumTerminalReplayCharacters,
  maximumEmergencyStopFailureMessageLength,
  maximumWorkspaceDeltaChunkLength,
  maximumWorkspaceDeltaOperations,
  protocolVersion,
  projectSwitchConfirmationErrorCode,
  rpcMethods,
  rpcRequestSchema,
  skillInventoryEntryFromSummary,
  workspaceDeltaSchema,
  type Annotation,
  type Artifact,
  type ArtifactAccessPurpose,
  type AuditActor,
  type AuditOutcome,
  type ProviderModel,
  type ProjectSwitchConfirmation,
  type RpcParams,
  type RpcMethod,
  type SessionHistoryPage,
  workspaceSnapshotSchema,
  type SessionHistoryEntry,
  type SystemEmergencyStopResult,
  type ClientKind,
  type Runtime,
  type TerminalOwner,
  type WorkspaceSnapshot,
  type WorkspaceDelta,
} from "@getdomovoi/protocol"
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from "ws"

import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import { TransferAssembler } from "./transfer-assembler.js"
import { createMachineDialer } from "./machine-dial.js"
import { openMachineSocket } from "./machine-socket.js"
import { sendSessionThroughRemote, sendSessionToMachine } from "./transfer-source.js"
import {
  CodexAppServerAdapter,
} from "./codex.js"
import { ClaudeAgentSdkAdapter } from "./claude.js"
import { OpenCodeSdkAdapter } from "./opencode.js"
import { KiloSdkAdapter } from "./kilo.js"
import { createCursorAgentAdapter, createGrokAgentAdapter } from "./acp-factory.js"
import {
  AgentProviderUnavailableError,
  AgentRegistry,
  type AgentAdapter,
  type AgentEvent,
} from "./agents.js"
import {
  GitWorkspaceService,
  WorkspaceEvidenceUnstableError,
  type WorkspaceService,
} from "./workspace.js"
import {
  injectPreviewBridge,
  validPreviewBridgeChannel,
  validPreviewParentOrigin,
} from "./preview-bridge.js"
import {
  AnnotationVisualContextService,
  type AnnotationVisualContextReader,
} from "./annotation-visual-context.js"
import { prepareAnnotationTurn } from "./annotation-visual-turn.js"
import { agentPromptWithHandoff } from "./handoff-context.js"
import { agentPromptWithSkills } from "./skill-context.js"
import {
  NodePtyTerminalService,
  type TerminalProcess,
  type TerminalService,
} from "./terminal.js"
import type { ProviderProbe } from "./providers.js"
import { FileSkillCatalog, SkillNotFoundError, skillRoots, type SkillCatalog } from "./skills.js"
import { ResourceMutationQueue } from "./resource-mutation-queue.js"
import {
  internalRpcErrorMessage,
  PublicRpcError,
  redactErrorDetail,
} from "./rpc-errors.js"
import { permissionDecisionFor } from "./permission-policy.js"
import { ProviderSecretManager } from "./provider-secrets.js"
import { UsageLedger } from "./usage.js"
import type { MachineIdentity } from "./machine-identity.js"
import type { TlsMaterial } from "./tls-material.js"
import { PairingCodeError, PairingCodeService } from "./pairing-codes.js"
import type { MachineCredentials } from "./machine-credentials.js"
import { advertisedTransports } from "./advertised-transports.js"
import { classifyProviderFailure, providerTurnCompletion } from "./provider-failures.js"
import {
  ArtifactWatcher,
  maximumArtifactFileBytes,
  type ArtifactFileChange,
  type SessionArtifactWatcherFactory,
} from "./artifact-watcher.js"
import { testEvidence } from "./test-evidence.js"
import { ArtifactContentLimitError, readBoundedArtifactContent } from "./artifact-content.js"
import { TerminalOutputBackpressure, TerminalOutputBatcher } from "./terminal-output.js"
import {
  RpcOutboundBackpressure,
  type RpcOutboundBackpressureOptions,
} from "./rpc-outbound.js"
import { PrintableArtifactError, safeArtifactFilename, sanitizePrintableArtifact } from "./print-artifact.js"
import type { AuditAppendInput, AuditLog } from "./audit-log.js"
import {
  appendDurableOutput,
  DurableOutputRedactor,
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
} from "./secret-redaction.js"

const invalidRequest = -32600
const methodNotFound = -32601
const invalidParams = -32602
// A machine accepts a bounded number of arriving transfers, so a source cannot
// fill this machine with half-delivered worktrees.
export const maximumIncomingTransfers = 4
// An arrival that goes quiet for this long has been abandoned, and its slot
// belongs to the next machine that needs it.
const incomingTransferIdleMs = 60_000
// A transfer that has stopped making progress is abandoned rather than left
// holding the request that asked for it.
const defaultSessionTransferTimeoutMs = 600_000
const internalError = -32603
const maximumAuthenticationFailures = 3
const preAuthAuditWindowMs = 60_000
export const maximumWebSocketPayloadBytes = 2 * 1_024 * 1_024
export const maximumAuthenticationPayloadBytes = 4 * 1_024
const sessionResourceMethods = new Set([
  "annotation.create",
  "checkpoint.create",
  "checkpoint.restore",
  "session.archive",
  "session.pause",
  "session.evidence",
  "session.fork",
  "session.history",
  "session.send",
  "session.restartProviderThread",
  "session.setRuntime",
])
const unauditedRpcMethods = new Set<RpcMethod>([
  "workspace.get",
  "runtime.models",
  "skill.list",
  "skill.inventory",
  "skill.read",
  "session.history",
  "session.evidence",
  "audit.query",
])

class RuntimeValidationError extends Error {}
class OperationTimeoutError extends PublicRpcError {
  constructor(message: string) {
    super(internalError, message)
    this.name = "OperationTimeoutError"
  }
}

function permissionViolation(runtime: Runtime, agent: AgentAdapter): string | undefined {
  const providerName = runtime.provider === "codex" ? "Codex" : runtime.provider
  if (runtime.permissionMode === "ask") {
    if (agent.permissionCapabilities?.ask === "read-only") return undefined
    return `${providerName} does not support enforceable Ask mode`
  }
  if (runtime.permissionMode !== "build" || !runtime.auto) return undefined
  if (agent.permissionCapabilities?.buildAuto === "pre-execution") return undefined
  return `${providerName} does not support enforceable Build auto`
}

function sessionIsArchiveReadOnly(
  session: WorkspaceSnapshot["sessions"][number] | undefined,
): boolean {
  return session?.state === "archiving" || session?.state === "archived"
}

function webSocketPayloadByteLength(data: WebSocket.RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength
}

export function appendPlanDelta(
  artifacts: Artifact[],
  annotations: Annotation[],
  sessionId: string,
  delta: string,
): Artifact {
  const artifactId = `plan-${sessionId}`
  const legacyPrefix = `${artifactId}-`
  const matching = artifacts.filter((artifact) =>
    artifact.sessionId === sessionId
    && artifact.type === "plan"
    && (artifact.id === artifactId || artifact.id.startsWith(legacyPrefix)),
  )

  if (matching.length === 0) {
    const artifact: Artifact = {
      id: artifactId,
      sessionId,
      title: "Working plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content: delta,
    }
    artifacts.push(artifact)
    return artifact
  }

  const mergedIds = new Set(matching.map((candidate) => candidate.id))
  const artifact = matching.find((candidate) => candidate.id === artifactId) ?? matching[0]!
  artifact.id = artifactId
  artifact.title = "Working plan"
  artifact.mimeType = "text/markdown"
  artifact.content = `${matching.map((candidate) => candidate.content ?? "").join("")}${delta}`
  artifact.revision = matching.reduce((total, candidate) => total + candidate.revision, 0) + 1

  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    if (matching.includes(artifacts[index]!) && artifacts[index] !== artifact) artifacts.splice(index, 1)
  }
  for (const annotation of annotations) {
    if (annotation.sessionId === sessionId && mergedIds.has(annotation.artifactId)) {
      annotation.artifactId = artifactId
    }
  }
  return artifact
}

export function workspaceDeltaChunks(value: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += maximumWorkspaceDeltaChunkLength) {
    chunks.push(value.slice(offset, offset + maximumWorkspaceDeltaChunkLength))
  }
  return chunks
}

export function workspaceSnapshotForClient(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const thread = boundedClientThread(snapshot.thread, snapshot.activeSessionId)
  const historyTruncated = thread.length < snapshot.thread.length
  return { ...snapshot, thread, ...(historyTruncated ? { historyTruncated: true } : {}) }
}

export function isTestCommandTitle(title: string): boolean {
  const command = title.trim().toLowerCase()
  const testScript = "test(?:[:.-][\\w.-]+)?(?:\\s|$)"
  return new RegExp(
    `^(?:(?:npm|yarn|bun)\\s+(?:run\\s+)?${testScript}`
      + `|pnpm(?:\\s+--filter\\s+\\S+)*\\s+(?:run\\s+)?${testScript}`
      + "|(?:npx\\s+)?(?:vitest|jest)(?:\\s|$)|pytest(?:\\s|$)"
      + "|(?:go|cargo|dotnet|swift|mix)\\s+test(?:\\s|$)"
      + "|(?:\\./)?gradle(?:w)?\\s+test(?:\\s|$)|mvn(?:\\s+\\S+)*\\s+test(?:\\s|$))",
  ).test(command)
}

function isProviderHandoff(item: Extract<WorkspaceSnapshot["thread"][number], { kind: "system" }>): boolean {
  return item.id.startsWith("handoff-") || item.body.startsWith("Handed off ")
}

export function sessionHistoryEntries(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): SessionHistoryEntry[] {
  const entries: SessionHistoryEntry[] = []
  for (const item of snapshot.thread) {
    if (item.sessionId !== sessionId) continue
    const base = {
      id: `thread:${item.id}`,
      sourceId: item.id,
      sessionId,
      createdAt: item.createdAt,
    }
    if (item.kind === "checkpoint") {
      entries.push({ ...base, category: "checkpoints", label: item.label, ...(item.commit ? { commit: item.commit } : {}) })
    } else if (item.kind === "user" || item.kind === "assistant") {
      entries.push({ ...base, category: "messages", role: item.kind, body: item.body })
    } else if (item.kind === "system") {
      entries.push(isProviderHandoff(item)
        ? { ...base, category: "handoffs", body: item.body, ...(item.detail ? { detail: item.detail } : {}) }
        : { ...base, category: "messages", role: "system", body: item.body, ...(item.detail ? { detail: item.detail } : {}) })
    } else if (item.kind === "receipt") {
      entries.push({
        ...base,
        category: "approvals",
        decision: item.decision,
        operation: item.operation,
        checkpoint: item.checkpoint,
        client: item.client,
        ...(item.connectionId ? { connectionId: item.connectionId } : {}),
        ...(item.clientId ? { clientId: item.clientId } : {}),
        ...(item.explanation ? { explanation: item.explanation } : {}),
      })
    } else {
      entries.push({
        ...base,
        category: isTestCommandTitle(item.title) ? "tests" : "tools",
        tool: item.tool,
        status: item.status,
        title: item.title,
        ...(item.output !== undefined ? { output: item.output } : {}),
      })
    }
  }
  for (const annotation of snapshot.annotations) {
    if (annotation.sessionId !== sessionId) continue
    entries.push({
      id: `annotation:${annotation.id}`,
      sourceId: annotation.id,
      sessionId,
      category: "annotations",
      annotationId: annotation.id,
      action: "created",
      body: annotation.body,
      origin: annotation.origin,
      artifactId: annotation.artifactId,
      status: annotation.status,
      createdAt: annotation.createdAt,
    })
    for (const reply of annotation.thread) {
      entries.push({
        id: `annotation-reply:${annotation.id}:${reply.id}`,
        sourceId: reply.id,
        sessionId,
        category: "annotations",
        annotationId: annotation.id,
        action: "reply",
        body: reply.body,
        origin: reply.origin,
        createdAt: reply.createdAt,
      })
    }
  }
  return entries.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
}

function sessionHistorySearchText(entry: SessionHistoryEntry): string {
  if (entry.category === "messages") return `${entry.body}\n${entry.detail ?? ""}`
  if (entry.category === "tools" || entry.category === "tests") {
    return `${entry.title}\n${entry.output ?? ""}\n${entry.status}\n${entry.tool}`
  }
  if (entry.category === "approvals") {
    return `${entry.operation}\n${entry.decision}\n${entry.checkpoint}\n${entry.client}\n${entry.explanation ?? ""}`
  }
  if (entry.category === "handoffs") return `${entry.body}\n${entry.detail ?? ""}`
  if (entry.category === "checkpoints") return `${entry.label}\n${entry.commit ?? ""}`
  return `${entry.body}\n${entry.origin}\n${entry.artifactId ?? ""}\n${entry.status ?? ""}`
}

export type SessionHistoryIndexMetrics = {
  indexBuilds: number
  indexedEntries: number
  filterScans: number
  filteredEntriesVisited: number
  pageLookups: number
  cachedFilterEntries: number
  filterEvictions: number
}

type IndexedSessionHistory = {
  entries: SessionHistoryEntry[]
  positions: Map<string, number>
}

type FilteredSessionHistory = { indices: number[] }

const maximumCachedSessionHistoryFilters = 32
export const maximumCachedSessionHistoryFilterEntries = 10_000
const allSessionHistoryCategories = [
  "annotations",
  "approvals",
  "checkpoints",
  "handoffs",
  "messages",
  "tests",
  "tools",
] as const

function indexedSessionHistory(entries: SessionHistoryEntry[]): IndexedSessionHistory {
  return {
    entries,
    positions: new Map(entries.map((entry, index) => [entry.id, index])),
  }
}

function filteredPosition(indices: number[], entryIndex: number): number | undefined {
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (indices[middle]! < entryIndex) low = middle + 1
    else high = middle
  }
  return indices[low] === entryIndex ? low : undefined
}

function throwIfHistoryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Session history request aborted", "AbortError")
}

export class SessionHistoryIndex {
  readonly #sessions = new Map<string, IndexedSessionHistory>()
  readonly #filters = new Map<string, { sessionId: string; history: FilteredSessionHistory }>()
  readonly #metrics: SessionHistoryIndexMetrics | undefined
  #cachedFilterEntries = 0

  constructor(metrics?: SessionHistoryIndexMetrics) {
    this.#metrics = metrics
  }

  invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#sessions.clear()
      this.#filters.clear()
      this.#cachedFilterEntries = 0
    } else {
      this.#sessions.delete(sessionId)
      for (const [key, filter] of this.#filters) {
        if (filter.sessionId !== sessionId) continue
        this.#cachedFilterEntries -= filter.history.indices.length
        this.#filters.delete(key)
      }
    }
    if (this.#metrics) this.#metrics.cachedFilterEntries = this.#cachedFilterEntries
  }

  page(
    snapshot: WorkspaceSnapshot,
    params: RpcParams<"session.history">,
    signal?: AbortSignal,
  ): SessionHistoryPage | undefined {
    throwIfHistoryAborted(signal)
    let indexed = this.#sessions.get(params.sessionId)
    if (!indexed) {
      const entries = sessionHistoryEntries(snapshot, params.sessionId)
      indexed = indexedSessionHistory(entries)
      this.#sessions.set(params.sessionId, indexed)
      if (this.#metrics) {
        this.#metrics.indexBuilds += 1
        this.#metrics.indexedEntries += entries.length
      }
    }

    const requestedCategories = params.categories
      ? [...new Set(params.categories)].sort()
      : undefined
    const categories = requestedCategories?.length === allSessionHistoryCategories.length
      && requestedCategories.every((category, offset) => category === allSessionHistoryCategories[offset])
      ? undefined
      : requestedCategories
    const query = params.query?.toLowerCase()
    let filtered: FilteredSessionHistory | undefined
    if (categories || query) {
      const filterKey = JSON.stringify([categories ?? null, query ?? null])
      const cacheKey = `${params.sessionId}\u0000${filterKey}`
      filtered = this.#filters.get(cacheKey)?.history
      if (!filtered) {
        const categorySet = categories ? new Set(categories) : undefined
        const indices: number[] = []
        if (this.#metrics) this.#metrics.filterScans += 1
        for (let offset = 0; offset < indexed.entries.length; offset += 1) {
          if ((offset & 255) === 0) throwIfHistoryAborted(signal)
          const entry = indexed.entries[offset]!
          if (this.#metrics) this.#metrics.filteredEntriesVisited += 1
          if (
            (!categorySet || categorySet.has(entry.category))
            && (!query || sessionHistorySearchText(entry).toLowerCase().includes(query))
          ) indices.push(offset)
        }
        throwIfHistoryAborted(signal)
        filtered = { indices }
        this.#filters.set(cacheKey, { sessionId: params.sessionId, history: filtered })
        this.#cachedFilterEntries += indices.length
        while (
          (this.#filters.size > maximumCachedSessionHistoryFilters
            || this.#cachedFilterEntries > maximumCachedSessionHistoryFilterEntries)
          && this.#filters.size > 1
        ) {
          const oldestKey = this.#filters.keys().next().value!
          const oldest = this.#filters.get(oldestKey)!
          this.#filters.delete(oldestKey)
          this.#cachedFilterEntries -= oldest.history.indices.length
          if (this.#metrics) this.#metrics.filterEvictions += 1
        }
      } else {
        const cached = this.#filters.get(cacheKey)!
        this.#filters.delete(cacheKey)
        this.#filters.set(cacheKey, cached)
      }
      if (this.#metrics) this.#metrics.cachedFilterEntries = this.#cachedFilterEntries
    }

    if (this.#metrics) this.#metrics.pageLookups += 1
    const beforeIndex = params.before === undefined ? undefined : indexed.positions.get(params.before)
    const end = params.before === undefined
      ? filtered?.indices.length ?? indexed.entries.length
      : beforeIndex === undefined
        ? undefined
        : filtered
          ? filteredPosition(filtered.indices, beforeIndex)
          : beforeIndex
    if (end === undefined) return undefined
    const start = Math.max(0, end - params.limit)
    const items = filtered
      ? filtered.indices.slice(start, end).map((offset) => indexed.entries[offset]!)
      : indexed.entries.slice(start, end)
    const hasMore = start > 0
    return {
      sessionId: params.sessionId,
      items,
      hasMore,
      ...(hasMore ? { nextCursor: items[0]!.id } : {}),
    }
  }
}

export function sessionHistoryPage(
  snapshot: WorkspaceSnapshot,
  params: RpcParams<"session.history">,
): SessionHistoryPage | undefined {
  return new SessionHistoryIndex().page(snapshot, params)
}

type AnnotationVisualContextStore = AnnotationVisualContextReader & Pick<
  AnnotationVisualContextService,
  "capture" | "storeUpload"
>

export function protectedAnnotationCropRefs(snapshot: WorkspaceSnapshot): string[] {
  const refs = new Set<string>()
  for (const annotation of snapshot.annotations) {
    const ref = annotation.visualContext?.status === "available" ? annotation.visualContext.ref : undefined
    if (ref && /^crop-[a-f0-9]{64}$/.test(ref)) refs.add(ref)
  }
  return [...refs].sort()
}

export const localMachineCapabilities = [
  "sessions",
  "terminals",
  "previews",
  "worktrees",
  "skills",
] as const satisfies readonly MachineCapability[]

export type DaemonServerOptions = {
  host?: string
  port?: number
  allowedOrigins?: string[]
  statePath?: string
  store?: WorkspaceStore
  agent?: AgentAdapter
  agents?: Readonly<Record<string, AgentAdapter>>
  workspaceService?: WorkspaceService
  worktreeRoot?: string
  agentTimeoutMs?: number
  modelCacheTtlMs?: number
  authToken?: string
  allowRemoteTransport?: boolean
  authTimeoutMs?: number
  terminalService?: TerminalService
  providerProbe?: ProviderProbe
  providerSecrets?: Pick<ProviderSecretManager, "status">
  usageLedger?: Pick<UsageLedger, "record" | "session" | "close">
  skillCatalog?: SkillCatalog
  errorSink?: DaemonErrorSink
  auditLog?: AuditLog
  artifactWatcherFactory?: SessionArtifactWatcherFactory
  annotationVisualContext?: AnnotationVisualContextStore
  machineIdentity?: MachineIdentity
  tls?: TlsMaterial
  advertiseHost?: string
  machineCredentials?: MachineCredentials
  readTransferBundle?: (bundlePath: string) => Promise<Buffer>
  sessionTransferTimeoutMs?: number
  connectToMachine?: (machineId: string, signal?: AbortSignal) => Promise<{
    call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    close: () => void
  }>
  rpcOutboundBackpressure?: RpcOutboundBackpressureOptions
}

export type DaemonErrorEntry = {
  context: string
  detail: string
}

export type DaemonErrorSink = (entry: DaemonErrorEntry) => void

type ActiveTerminal = {
  sessionId: string
  process: TerminalProcess
  cols: number
  rows: number
  shell: string
  cwd: string
  buffer: string
  owner: TerminalOwner
  output: TerminalOutputBatcher
  outputBackpressure: TerminalOutputBackpressure
  disposeData: () => void
  disposeExit: () => void
}

export class DomovoiDaemon {
  readonly host: string
  readonly requestedPort: number
  readonly allowedOrigins: ReadonlySet<string>
  #http: HttpServer | undefined
  #websocket: WebSocketServer | undefined
  #snapshot: WorkspaceSnapshot
  #store: WorkspaceStore
  #auditLog: AuditLog | undefined
  #pendingAudits = new WeakMap<WebSocket, Map<string, AuditAppendInput>>()
  #commandOutputRedactors = new Map<string, { itemId: string; redactor: DurableOutputRedactor }>()
  #agents: AgentRegistry
  #workspaceService: WorkspaceService
  #connectedAgents = new Set<string>()
  #agentConnections = new Map<string, Promise<void>>()
  #agentConnectionResets = new Map<string, Promise<void>>()
  #providerModels = new Map<string, { models: ProviderModel[]; cachedAt: number }>()
  #providerModelRequests = new Map<string, Promise<ProviderModel[]>>()
  #providerEpochs = new Map<string, number>()
  #loadedAgentThreads = new Set<string>()
  #unsubscribeAgents: Array<() => void>
  #mutations = new ResourceMutationQueue((error) => {
    this.#reportError("Domovoi mutation failed", error)
  })
  #deltaFlush: ReturnType<typeof setTimeout> | undefined
  #agentTimeoutMs: number
  #modelCacheTtlMs: number
  #authToken: string
  #authenticatedClients = new WeakSet<WebSocket>()
  #deviceCredentials = new WeakMap<WebSocket, string>()
  #authenticatedActors = new WeakMap<WebSocket, AuditActor>()
  #connectionIds = new WeakMap<WebSocket, string>()
  #preAuthAuditDeadlines = new Map<"authentication" | "invalid-request", number>()
  #authenticationDeadlines = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()
  #authenticationFailures = new WeakMap<WebSocket, number>()
  #authTimeoutMs: number
  #artifactSigningSecret = randomBytes(32).toString("base64url")
  #artifactAccessTtlSeconds = 60
  #terminalService: TerminalService
  #terminals = new Map<string, ActiveTerminal>()
  #providerProbe: ProviderProbe | undefined
  #providerSecrets: Pick<ProviderSecretManager, "status">
  #usageLedger: Pick<UsageLedger, "record" | "session" | "close">
  #providerRefresh: Promise<void> | undefined
  #skillCatalog: SkillCatalog | undefined
  #workspaceAbort = new AbortController()
  #emergencyBlockedThreads = new Set<string>()
  #failedEmergencyThreads = new Set<string>()
  #inFlightProviderThreads = new Map<string, string>()
  #emergencyStopTail: Promise<unknown> = Promise.resolve()
  #stopping = false
  #stopped = false
  #stopPromise: Promise<void> | undefined
  #errorSink: DaemonErrorSink
  #tls: TlsMaterial | undefined
  #advertiseHost: string | undefined
  #pairing: PairingCodeService | undefined
  #machineCredentials: MachineCredentials | undefined
  #readTransferBundle: ((bundlePath: string) => Promise<Buffer>) | undefined
  #sessionTransferTimeoutMs: number
  #connectToMachine: (machineId: string, signal?: AbortSignal) => Promise<{
    call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    close: () => void
  }>
  #artifactWatcherFactory: SessionArtifactWatcherFactory
  #artifactWatchers = new Map<string, { root: string; watcher: ReturnType<SessionArtifactWatcherFactory> }>()
  #annotationVisualContext: AnnotationVisualContextStore
  #incomingTransfers = new Map<string, {
    sessionId: string
    assembler: TransferAssembler
    socket: WebSocket
    idle: ReturnType<typeof setTimeout>
  }>()
  #rpcOutbound: RpcOutboundBackpressure
  #sessionHistory = new SessionHistoryIndex()

  constructor(options: DaemonServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
    this.requestedPort = options.port ?? 47831
    this.#modelCacheTtlMs = Math.max(0, options.modelCacheTtlMs ?? 60_000)
    this.#errorSink = options.errorSink ?? ((entry) => console.error(entry.context, entry.detail))
    this.#tls = options.tls
    this.#advertiseHost = options.advertiseHost
    this.#machineCredentials = options.machineCredentials
    this.#readTransferBundle = options.readTransferBundle ?? ((bundlePath) => readFile(bundlePath))
    this.#sessionTransferTimeoutMs = options.sessionTransferTimeoutMs ?? defaultSessionTransferTimeoutMs
    // With nothing supplied, this daemon reaches other machines itself: the
    // fleet says where they are, pairing left the credential here, and the
    // socket carries the transfer calls.
    this.#connectToMachine = options.connectToMachine ?? createMachineDialer({
      machines: () => this.#store.fleet?.snapshot(
        this.#snapshot.machine.id,
        Date.now(),
      ).machines ?? [],
      credentials: this.#machineCredentials,
      open: ({ endpoint, credential, signal }) => openMachineSocket({
        endpoint,
        credential,
        ...(signal ? { signal } : {}),
      }),
    })
    if (!isLoopbackHost(this.host) && !options.allowRemoteTransport) {
      throw new Error("Non-loopback listeners require explicit protected-transport opt-in")
    }
    this.allowedOrigins = new Set(
      options.allowedOrigins ?? ["http://127.0.0.1:5178", "http://localhost:5178", "file://"],
    )
    this.#rpcOutbound = new RpcOutboundBackpressure(options.rpcOutboundBackpressure)
    const machinePlatform = platform()
    const machineArch = arch()
    const machineName = options.machineIdentity?.label ?? hostname()
    const initialSnapshot = createEmptyWorkspace({
      id: options.machineIdentity?.id
        ?? `machine-${createHash("sha256").update(`${hostname()}:${machinePlatform}:${machineArch}`).digest("hex").slice(0, 32)}`,
      name: machineName,
      platform: machinePlatform,
      arch: machineArch,
      version: "0.0.1",
      connection: "local",
      reachable: true,
      providers: [],
    })
    const statePath = options.statePath ?? join(homedir(), ".domovoi", "state.sqlite")
    this.#annotationVisualContext = options.annotationVisualContext
      ?? new AnnotationVisualContextService({
        root: join(dirname(statePath), "annotation-crops"),
        protectedRefs: () => protectedAnnotationCropRefs(this.#snapshot),
        reportRetentionOverflow: ({ fileCount, totalBytes }) => this.#errorSink({
          context: "annotation crop retention",
          detail: `Protected crop retention exceeds bounds (${fileCount} files, ${totalBytes} bytes)`,
        }),
        // Every other error this daemon reports goes through one bounded,
        // secret-redacting path, and these are no different.
        reportRetentionError: (error) => this.#reportError("annotation crop retention", error),
      })
    this.#store = options.store ?? new SqliteWorkspaceStore(
      statePath,
      initialSnapshot,
      {
        legacySnapshots: [demoWorkspace],
        manageDirectoryPermissions: options.statePath === undefined,
      },
    )
    const usagePath = options.store || statePath === ":memory:"
      ? ":memory:"
      : join(dirname(statePath), "usage.sqlite")
    this.#usageLedger = options.usageLedger ?? new UsageLedger(usagePath)
    this.#auditLog = options.auditLog ?? this.#store.auditLog
    this.#pairing = this.#store.devices
      ? new PairingCodeService(this.#store.devices)
      : undefined
    this.#snapshot = this.#store.load()
    this.#agents = new AgentRegistry(
      options.agents ?? {
        "claude-code": new ClaudeAgentSdkAdapter(),
        codex: options.agent ?? new CodexAppServerAdapter(),
        "cursor-agent": createCursorAgentAdapter(),
        grok: createGrokAgentAdapter(),
        kilo: new KiloSdkAdapter(),
        opencode: new OpenCodeSdkAdapter(),
      },
    )
    this.#workspaceService = options.workspaceService ?? new GitWorkspaceService(
      options.worktreeRoot ?? join(homedir(), ".domovoi", "worktrees"),
    )
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 30_000
    this.#authToken = options.authToken ?? randomBytes(32).toString("base64url")
    this.#authTimeoutMs = options.authTimeoutMs ?? 5_000
    this.#terminalService = options.terminalService ?? new NodePtyTerminalService()
    this.#providerProbe = options.providerProbe
    this.#providerSecrets = options.providerSecrets ?? new ProviderSecretManager()
    this.#skillCatalog = options.skillCatalog
    this.#artifactWatcherFactory = options.artifactWatcherFactory
      ?? ((watcherOptions) => new ArtifactWatcher(watcherOptions))
    this.#unsubscribeAgents = this.#agents.entries().map(([provider, agent]) =>
      agent.onEvent((event) => {
        if (this.#stopping || this.#stopped) return
        if (event.type === "provider-disconnected") {
          void this.#enqueueMutation(() => this.#handleAgentEvent(provider, event))
        } else {
          void this.#mutations.enqueue(
            this.#resourceForAgentEvent(provider, event),
            () => this.#handleAgentEvent(provider, event),
          )
        }
      }),
    )
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.#http?.address()
    if (!address || typeof address === "string") return undefined
    return { host: this.host, port: address.port }
  }

  // The local daemon is the one machine this registry can observe directly, so
  // its heartbeat is refreshed whenever a client reads the fleet.
  #recordThisMachine(): void {
    const machine = this.#snapshot.machine
    try {
      this.#store.fleet?.record({
        id: machine.id,
        label: machine.name,
        platform: machine.platform,
        arch: machine.arch,
        version: machine.version,
        connection: "local",
        capabilities: [...localMachineCapabilities],
        protocolVersion,
        transports: advertisedTransports({
          host: this.host,
          port: this.address?.port ?? this.requestedPort,
          ...(this.#tls ? { tls: true } : {}),
          ...(this.#advertiseHost ? { advertiseHost: this.#advertiseHost } : {}),
        }),
      }, Date.now())
    } catch (error) {
      this.#reportError("Domovoi could not record this machine in the fleet", error)
    }
  }

  #credentialAccepted(socket: WebSocket, token: string | undefined): boolean {
    if (secureTokenMatch(this.#authToken, token)) return true
    if (!token) return false
    if (this.#store.devices?.verify(token) === undefined) return false
    this.#deviceCredentials.set(socket, token)
    return true
  }

  // Revocation has to reach a device that is only listening, so its socket is
  // closed as soon as its credential stops being active.
  #disconnectInactiveDevices(): void {
    for (const client of this.#websocket?.clients ?? []) {
      if (this.#deviceCredentials.get(client) === undefined) continue
      if (this.#deviceCredentialActive(client)) continue
      this.#authenticatedClients.delete(client)
      client.close(1008, "device credential revoked")
    }
  }

  // A paired device can be revoked or rotated while it holds an open socket, so
  // its credential is rechecked for every request rather than only at connect.
  #deviceCredentialActive(socket: WebSocket): boolean {
    const token = this.#deviceCredentials.get(socket)
    if (token === undefined) return true
    return this.#store.devices?.isActive(token) === true
  }

  issuePairingCode(): { code: string; expiresAt: string } {
    if (!this.#pairing) throw new Error("Device pairing is unavailable")
    return this.#pairing.issue(Date.now())
  }

  get authToken(): string {
    return this.#authToken
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.#stopping || this.#stopped) throw new Error("Daemon cannot restart after shutdown")
    if (this.#http) throw new Error("Daemon is already running")

    await this.#recoverSessionArchives()
    this.#recoverInterruptedTurns()
    this.#syncArtifactWatchers()

    const listen = this.#tls
      ? (requestHandler: Parameters<typeof createServer>[1]) => createSecureServer(
        { cert: this.#tls!.cert, key: this.#tls!.key },
        requestHandler,
      )
      : (requestHandler: Parameters<typeof createServer>[1]) => createServer(requestHandler)
    this.#http = listen((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "ok", protocolVersion }))
        return
      }

      if (request.method === "GET" && request.url?.startsWith("/artifacts/")) {
        if (!this.#acceptsHost(request.headers.host)) {
          response.writeHead(404, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "not_found" }))
          return
        }
        void this.#serveArtifact(request.url, response)
        return
      }

      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
    })

    const verifyClient: VerifyClientCallbackSync = ({ origin }) =>
      !this.#stopping && !this.#stopped && (!origin || this.allowedOrigins.has(origin))

    this.#websocket = new WebSocketServer({
      server: this.#http,
      path: "/rpc",
      verifyClient,
      maxPayload: maximumWebSocketPayloadBytes,
    })
    this.#websocket.on("connection", (socket, request) => {
      socket.once("close", () => this.#rpcOutbound.forget(socket))
      socket.on("error", (error: Error & { code?: string }) => {
        if (error.code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
          this.#reportError("Domovoi WebSocket failed", error)
        }
      })
      const authorization = request.headers.authorization
      const bearerToken = typeof authorization === "string"
        ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1]
        : undefined
      if (this.#credentialAccepted(socket, bearerToken)) {
        this.#authenticatedClients.add(socket)
      } else {
        const deadline = setTimeout(() => {
          if (!this.#authenticatedClients.has(socket)) socket.close(1008, "authentication timeout")
        }, this.#authTimeoutMs)
        this.#authenticationDeadlines.set(socket, deadline)
        socket.once("close", () => clearTimeout(deadline))
      }
      socket.on("message", (data) => {
        if (
          !this.#authenticatedClients.has(socket)
          && webSocketPayloadByteLength(data) > maximumAuthenticationPayloadBytes
        ) {
          socket.close(1009, "authentication payload too large")
          return
        }
        const raw = data.toString()
        if (this.#stopping || this.#stopped) {
          let id: string | number | null = null
          try {
            const request = JSON.parse(raw) as { id?: unknown }
            if (typeof request.id === "string" || typeof request.id === "number") id = request.id
            else return
          } catch {
            // The daemon is already shutting down; a stable unavailable response is sufficient.
          }
          this.#error(socket, id, daemonShuttingDownErrorCode, "Daemon is shutting down")
          return
        }
        if (!this.#authenticatedClients.has(socket)) {
          void this.#handle(socket, raw)
          return
        }
        const resource = this.#requestResource(raw)
        if (resource) {
          void this.#mutations.enqueue(
            resource,
            (signal) => this.#handle(socket, raw, signal),
            { onCancelled: () => this.#cancelRpcRequest(socket, raw) },
          )
        } else if (
          this.#bypassesMutationQueue(raw)
          && this.#authenticatedClients.has(socket)
        ) void this.#handle(socket, raw)
        else void this.#mutations.enqueueExclusive(
          (signal) => this.#handle(socket, raw, signal),
          { onCancelled: () => this.#cancelRpcRequest(socket, raw) },
        )
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.#http!.once("error", reject)
      this.#http!.listen(this.requestedPort, this.host, () => resolve())
    })

    if (this.#providerProbe) this.#queueProviderRefresh(true)

    return this.address!
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#closeArtifactWatchers()
    for (const unsubscribe of this.#unsubscribeAgents.splice(0)) unsubscribe()
    const stopping = this.#finishStop()
    this.#stopPromise = stopping
    return stopping
  }

  async #finishStop(): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.#providerRefresh
      await this.#mutations.drain()
      if (this.#deltaFlush) await this.#saveAgentState(false)
    } catch (error) {
      failures.push(error)
    }
    this.#closeAllTerminals()
    this.#rpcOutbound.dispose()
    for (const client of this.#websocket?.clients ?? []) client.close(1001, "daemon stopping")

    try {
      await new Promise<void>((resolve, reject) => {
        if (!this.#http) return resolve()
        this.#http.close((error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      failures.push(error)
    }

    this.#websocket = undefined
    this.#http = undefined
    const providerClosures = await Promise.allSettled(
      this.#agents.adapters().map((agent) => agent.close()),
    )
    failures.push(...providerClosures.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    ))
    try {
      await this.#store.close()
    } catch (error) {
      failures.push(error)
    }
    try {
      this.#usageLedger.close()
    } catch (error) {
      failures.push(error)
    }
    this.#stopped = true
    if (failures.length > 0) throw new AggregateError(failures, "Domovoi shutdown failed")
  }

  #send(socket: WebSocket, payload: unknown): void {
    this.#completeAudit(socket, payload)
    this.#sendWithoutAudit(socket, payload)
  }

  #sendWithoutAudit(socket: WebSocket, payload: unknown): void {
    this.#rpcOutbound.send(socket, JSON.stringify(payload))
  }

  #appendAudit(input: AuditAppendInput): void {
    try {
      this.#auditLog?.append(input)
    } catch (error) {
      this.#reportError("Domovoi could not persist audit entry", error)
    }
  }

  #appendPreAuthAudit(kind: "authentication" | "invalid-request"): void {
    const now = Date.now()
    if ((this.#preAuthAuditDeadlines.get(kind) ?? 0) > now) return
    this.#preAuthAuditDeadlines.set(kind, now + preAuthAuditWindowMs)
    this.#appendAudit({
      actor: { kind: "daemon", component: kind === "authentication" ? kind : "rpc" },
      action: `security.${kind}`,
      outcome: kind === "authentication" ? "denied" : "failed",
    })
  }

  #registerAudit(
    socket: WebSocket,
    id: string | number | null,
    method: RpcMethod,
    params: unknown,
  ): boolean {
    if (!this.#auditLog || unauditedRpcMethods.has(method)) return true
    const values = params && typeof params === "object" ? params as Record<string, unknown> : {}
    const actor: AuditActor = this.#authenticatedActors.get(socket)
      ?? { kind: "daemon", component: "rpc" }
    const sessionId = this.#auditSessionId(values)
    const target = ["artifactId", "approvalId", "terminalId", "checkpointId", "annotationId", "deviceId"]
      .map((key) => values[key])
      .find((value): value is string => typeof value === "string")
      ?? (method === "skill.setEnabled" && typeof values.id === "string" ? values.id : undefined)
    const pending = this.#pendingAudits.get(socket) ?? new Map<string, AuditAppendInput>()
    const key = JSON.stringify(id)
    if (pending.has(key)) return false
    pending.set(key, {
      actor,
      action: method,
      outcome: method === "approval.resolve" && values.decision === "deny" ? "denied" : "succeeded",
      ...(sessionId ? { sessionId } : {}),
      ...(this.#snapshot.project ? { projectId: this.#snapshot.project.id } : {}),
      ...(target ? { target } : {}),
      ...(method === "skill.setEnabled"
        ? { detail: `enabled=${values.enabled === true} digest=${String(values.contentDigest ?? "")}` }
        : {}),
    })
    this.#pendingAudits.set(socket, pending)
    return true
  }

  #auditSessionId(values: Record<string, unknown>): string | undefined {
    if (typeof values.sessionId === "string") return values.sessionId
    if (typeof values.approvalId === "string") {
      return this.#snapshot.approvals.find(({ id }) => id === values.approvalId)?.sessionId
    }
    if (typeof values.annotationId === "string") {
      return this.#snapshot.annotations.find(({ id }) => id === values.annotationId)?.sessionId
    }
    if (typeof values.terminalId === "string") return this.#terminals.get(values.terminalId)?.sessionId
    return undefined
  }

  #completeAudit(socket: WebSocket, payload: unknown): void {
    if (!payload || typeof payload !== "object") return
    const response = payload as { id?: unknown; error?: unknown; result?: unknown }
    if (response.id === undefined) return
    const pending = this.#pendingAudits.get(socket)
    const key = JSON.stringify(response.id)
    const input = pending?.get(key)
    if (!input) return
    pending!.delete(key)
    const result = "result" in response && response.result && typeof response.result === "object"
      ? response.result as Record<string, unknown>
      : undefined
    const project = result?.project && typeof result.project === "object"
      ? result.project as Record<string, unknown>
      : undefined
    const resultingSessionId = (input.action === "session.create" || input.action === "session.fork")
      && typeof result?.activeSessionId === "string"
      ? result.activeSessionId
      : undefined
    const responseError = response.error && typeof response.error === "object"
      ? response.error as Record<string, unknown>
      : undefined
    const failureOutcome: AuditOutcome = typeof responseError?.message === "string"
      && responseError.message.toLowerCase().includes("timed out")
      ? "cancelled"
      : "failed"
    this.#appendAudit({
      ...input,
      outcome: response.error === undefined ? input.outcome : failureOutcome,
      ...(resultingSessionId ? { sessionId: resultingSessionId } : {}),
      ...(input.action === "project.open" && typeof project?.id === "string"
        ? { projectId: project.id }
        : {}),
    })
  }

  #broadcastSnapshot(): void {
    this.#broadcastNotification("workspace.changed", workspaceSnapshotForClient(this.#snapshot))
  }

  #broadcastNotification(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params })

    for (const client of this.#websocket?.clients ?? []) {
      if (
        client.readyState === WebSocket.OPEN
        && this.#authenticatedClients.has(client)
        && this.#deviceCredentialActive(client)
      ) {
        this.#rpcOutbound.notify(
          client,
          method,
          message,
          () => JSON.stringify({
            jsonrpc: "2.0",
            method: "workspace.changed",
            params: workspaceSnapshotForClient(this.#snapshot),
          }),
        )
      }
    }
  }

  #maximumAuthenticatedClientBufferedBytes(): number {
    let maximum = 0
    for (const client of this.#websocket?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN && this.#authenticatedClients.has(client)) {
        maximum = Math.max(maximum, client.bufferedAmount)
      }
    }
    return maximum
  }

  async #refreshProviderReadiness(): Promise<void> {
    const sessionProviders = new Set(this.#agents.providers())
    const providers = (await this.#providerProbe!.inspect()).map((provider) => ({
      ...provider,
      sessionCapable: sessionProviders.has(provider.id),
    }))
    await this.#enqueueMutation(async () => {
      this.#snapshot.machine.providers = providers
      const clientSnapshot = structuredClone(workspaceSnapshotForClient(this.#snapshot))
      await this.#persistSnapshot()
      this.#broadcastNotification("workspace.changed", clientSnapshot)
    })
  }

  #queueProviderRefresh(reportError: boolean): Promise<void> {
    const previous = this.#providerRefresh ?? Promise.resolve()
    const refresh = previous.catch(() => {}).then(() => this.#refreshProviderReadiness())
    const observed = refresh.catch((error: unknown) => {
      if (reportError) this.#reportError("Domovoi could not inspect provider runtimes", error)
    })
    this.#providerRefresh = observed
    return reportError ? observed : refresh
  }

  #error(
    socket: WebSocket,
    id: string | number | null,
    code: number,
    message: string,
    data?: ProjectSwitchConfirmation,
  ): void {
    this.#send(socket, {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    })
  }

  #recordTransferRefusal(
    sessionId: string,
    targetMachineId: string,
    client: ClientKind,
    reason: TransferReceipt["reason"],
  ): void {
    const at = new Date().toISOString()
    // A receipt is a record of what happened, not part of the answer: a daemon
    // that cannot store one still has to tell the caller it refused.
    try {
      this.#store.transferReceipts?.record({
        sessionId,
        sourceMachineId: this.#snapshot.machine.id,
        targetMachineId,
        method: "git-bundle",
        checkpointId: `checkpoint-${"0".repeat(40)}`,
        checkpointCommit: "0".repeat(40),
        recoveryCheckpointRetained: true,
        outcome: "refused",
        ...(reason ? { reason } : {}),
        decidedBy: { client },
        startedAt: at,
        completedAt: at,
      })
    } catch (error) {
      this.#reportError("Domovoi could not record a transfer receipt", error)
    }
  }

  #scheduleTransferExpiry(transferId: string): ReturnType<typeof setTimeout> {
    const expiry = setTimeout(() => this.#forgetTransfer(transferId), incomingTransferIdleMs)
    expiry.unref?.()
    return expiry
  }

  #forgetTransfer(transferId: string): void {
    const incoming = this.#incomingTransfers.get(transferId)
    if (!incoming) return
    clearTimeout(incoming.idle)
    this.#incomingTransfers.delete(transferId)
  }

  #forgetTransfersFrom(socket: WebSocket): void {
    for (const [transferId, incoming] of this.#incomingTransfers) {
      if (incoming.socket === socket) this.#forgetTransfer(transferId)
    }
  }

  #reportError(context: string, error: unknown): void {
    try {
      this.#errorSink({ context, detail: redactErrorDetail(error) })
    } catch {
      // Diagnostics must never prevent the daemon from returning a stable response.
    }
  }

  #acceptsHost(host: string | undefined): boolean {
    const address = this.address
    if (!host || !address) return false
    return hostAuthorityMatches(host, address.host, address.port)
  }

  #enqueueMutation(task: () => Promise<void>): Promise<void> {
    return this.#mutations.enqueueExclusive(task)
  }

  #cancelRpcRequest(socket: WebSocket, raw: string): void {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      const request = JSON.parse(raw) as { id?: unknown }
      if (typeof request.id !== "string" && typeof request.id !== "number") return
      this.#error(socket, request.id, internalError, "Operation cancelled by emergency stop")
    } catch {
      // Invalid requests do not need a cancellation response.
    }
  }

  #requestResource(raw: string): string | undefined {
    try {
      const request = JSON.parse(raw) as {
        method?: unknown
        params?: {
          annotationId?: unknown
          approvalId?: unknown
          sessionId?: unknown
          terminalId?: unknown
        }
      }
      if (typeof request.method !== "string") return undefined
      if (
        request.method.startsWith("terminal.")
        && typeof request.params?.terminalId === "string"
      ) return `terminal:${request.params.terminalId}`
      if (
        sessionResourceMethods.has(request.method)
        && typeof request.params?.sessionId === "string"
      ) return `session:${request.params.sessionId}`
      if (
        (request.method === "annotation.reply" || request.method === "annotation.setStatus")
        && typeof request.params?.annotationId === "string"
      ) {
        const annotation = this.#snapshot.annotations.find(
          (candidate) => candidate.id === request.params!.annotationId,
        )
        if (annotation) return `session:${annotation.sessionId}`
      }
      if (request.method === "approval.resolve" && typeof request.params?.approvalId === "string") {
        const approval = this.#snapshot.approvals.find(
          (candidate) => candidate.id === request.params!.approvalId,
        )
        if (approval) return `session:${approval.sessionId}`
      }
      return undefined
    } catch {
      return undefined
    }
  }

  #resourceForAgentEvent(provider: string, event: AgentEvent): string {
    const threadId = threadIdForAgentEvent(event)
    const session = threadId
      ? this.#snapshot.sessions.find(
          (candidate) =>
            candidate.runtime.provider === provider && candidate.providerThreadId === threadId,
        )
      : undefined
    return session ? `session:${session.id}` : `provider:${provider}:${threadId ?? "unscoped"}`
  }

  #bypassesMutationQueue(raw: string): boolean {
    try {
      const request = JSON.parse(raw) as { method?: unknown }
      return request.method === "runtime.models"
        || request.method === "provider.refresh"
        || request.method === "provider.secret.list"
        || request.method === "session.usage"
        || request.method === "skill.list"
        || request.method === "skill.inventory"
        || request.method === "skill.read"
        || request.method === "audit.query"
        || request.method === "audit.export"
        || request.method === "system.emergencyStop"
    } catch {
      return false
    }
  }

  async #ensureAgentConnected(provider = "codex"): Promise<AgentAdapter> {
    const agent = this.#agents.require(provider)
    if (this.#connectedAgents.has(provider)) return agent
    await this.#agentConnectionResets.get(provider)
    if (!this.#agentConnections.has(provider)) {
      const epoch = this.#providerEpoch(provider)
      const connection = agent.connect().then(() => {
        if (this.#providerEpoch(provider) === epoch) this.#connectedAgents.add(provider)
      })
      this.#agentConnections.set(provider, connection)
      void connection.then(
        () => { if (this.#agentConnections.get(provider) === connection) this.#agentConnections.delete(provider) },
        () => { if (this.#agentConnections.get(provider) === connection) this.#agentConnections.delete(provider) },
      )
    }
    const pendingConnection = this.#agentConnections.get(provider)!
    try {
      await withTimeout(
        pendingConnection,
        this.#agentTimeoutMs,
        "Agent setup timed out",
      )
    } catch (error) {
      if (
        error instanceof OperationTimeoutError
        && this.#agentConnections.get(provider) === pendingConnection
      ) {
        this.#agentConnections.delete(provider)
        this.#providerEpochs.set(provider, this.#providerEpoch(provider) + 1)
        if (agent.resetConnection) {
          const reset = Promise.resolve().then(() => agent.resetConnection!())
          const resetSettlement = reset.catch((resetError) => {
            this.#reportError(`Agent provider ${provider} connection reset failed`, resetError)
          })
          this.#agentConnectionResets.set(provider, resetSettlement)
          void resetSettlement.then(() => {
            if (this.#agentConnectionResets.get(provider) === resetSettlement) {
              this.#agentConnectionResets.delete(provider)
            }
          })
          await withTimeout(
            resetSettlement,
            this.#agentTimeoutMs,
            "Agent connection reset timed out",
          ).catch((resetError) => {
            this.#reportError(`Agent provider ${provider} connection reset failed`, resetError)
          })
        }
      }
      throw error
    }
    if (!this.#connectedAgents.has(provider)) {
      if (this.#agentConnections.get(provider) === pendingConnection) {
        this.#agentConnections.delete(provider)
      }
      throw new Error(`Agent provider ${provider} disconnected during setup`)
    }
    return agent
  }

  async #listProviderModels(provider: string): Promise<ProviderModel[]> {
    const cached = this.#providerModels.get(provider)
    if (cached && Date.now() - cached.cachedAt < this.#modelCacheTtlMs) return cached.models
    const agent = await this.#ensureAgentConnected(provider)
    if (!this.#providerModelRequests.has(provider)) {
      const epoch = this.#providerEpoch(provider)
      const discovery = agent.listModels().then((models) => {
        const parsed = rpcMethods["runtime.models"].result.parse(models)
          .filter((model) => model.provider === provider)
        if (parsed.length > 0 && this.#providerEpoch(provider) === epoch) {
          this.#providerModels.set(provider, { models: parsed, cachedAt: Date.now() })
        }
        return parsed
      })
      this.#providerModelRequests.set(provider, discovery)
      void discovery.then(
        () => { if (this.#providerModelRequests.get(provider) === discovery) this.#providerModelRequests.delete(provider) },
        () => { if (this.#providerModelRequests.get(provider) === discovery) this.#providerModelRequests.delete(provider) },
      )
    }
    return withTimeout(
      this.#providerModelRequests.get(provider)!,
      this.#agentTimeoutMs,
      "Model discovery timed out",
    )
  }

  async #resolveRuntime(runtime: Runtime): Promise<Runtime> {
    let agent: AgentAdapter
    try {
      agent = this.#agents.require(runtime.provider)
    } catch (error) {
      if (error instanceof AgentProviderUnavailableError) {
        throw new RuntimeValidationError(error.message)
      }
      throw error
    }
    const violation = permissionViolation(runtime, agent)
    if (violation) throw new RuntimeValidationError(violation)
    let models: ProviderModel[]
    try {
      models = await this.#listProviderModels(runtime.provider)
    } catch (error) {
      if (error instanceof AgentProviderUnavailableError) {
        throw new RuntimeValidationError(error.message)
      }
      throw error
    }
    const model = runtime.model === "default"
      ? models.find((candidate) => candidate.isDefault) ?? models[0]
      : models.find((candidate) => candidate.id === runtime.model)
    if (!model) throw new RuntimeValidationError(`Model is not available from ${runtime.provider}`)
    const supportedReasoningEfforts = model.supportedReasoningEfforts.length > 0
      ? model.supportedReasoningEfforts
      : [model.defaultReasoningEffort]
    const reasoning = runtime.model === "default"
      && !supportedReasoningEfforts.includes(runtime.reasoning)
      ? model.defaultReasoningEffort
      : runtime.reasoning
    if (!supportedReasoningEfforts.includes(reasoning)) {
      throw new RuntimeValidationError("Reasoning effort is not supported by the selected model")
    }
    return { ...runtime, model: model.id, reasoning }
  }

  async #serveArtifact(url: string, response: import("node:http").ServerResponse): Promise<void> {
    let artifactId: string
    let sessionId: string | undefined
    let revision: number | undefined
    let purpose: ArtifactAccessPurpose = "preview"
    let bridgeChannel: string | undefined
    let parentOrigin: string | undefined
    let authorized: boolean
    try {
      const requestUrl = new URL(url, "http://domovoi.local")
      artifactId = decodeURIComponent(requestUrl.pathname.slice("/artifacts/".length))
      sessionId = requestUrl.searchParams.get("session") || undefined
      const requestedRevision = Number(requestUrl.searchParams.get("revision"))
      revision = Number.isSafeInteger(requestedRevision) && requestedRevision > 0 ? requestedRevision : undefined
      const requestedPurpose = requestUrl.searchParams.get("purpose")
      if (requestedPurpose === "print" || requestedPurpose === "download") purpose = requestedPurpose
      else if (requestedPurpose !== null && requestedPurpose !== "preview") throw new Error("Invalid artifact purpose")
      bridgeChannel = validPreviewBridgeChannel(requestUrl.searchParams.get("bridge"))
      if (purpose !== "preview" && bridgeChannel) throw new Error("Derived artifacts cannot use the preview bridge")
      parentOrigin = validPreviewParentOrigin(requestUrl.searchParams.get("parentOrigin"))
      const expiresAt = Number(requestUrl.searchParams.get("expires"))
      const signature = requestUrl.searchParams.get("signature")
      authorized = Boolean(sessionId && revision && artifactAccessMatches(
        this.#artifactSigningSecret,
        { sessionId, artifactId, revision, purpose, ...(bridgeChannel ? { bridgeChannel } : {}), expiresAt },
        signature,
      ))
    } catch {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }
    if (!canServeArtifacts(this.host, authorized) || (purpose !== "preview" && !authorized)) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }

    const artifact = this.#snapshot.artifacts.find(
      (candidate) => candidate.id === artifactId && candidate.type === "preview",
    )
    const session = artifact
      ? this.#snapshot.sessions.find((candidate) => candidate.id === artifact.sessionId)
      : undefined
    const path = artifact?.path && session?.workspacePath
      ? await resolveInsideReal(session.workspacePath, artifact.path)
      : undefined
    if (
      !artifact
      || artifact.mimeType !== "text/html"
      || !path
      || (authorized && (artifact.sessionId !== sessionId || artifact.revision !== revision))
    ) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }

    try {
      const content = await readBoundedArtifactContent(path)
      const derived = purpose === "preview" ? undefined : sanitizePrintableArtifact(content, artifact.title)
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": purpose === "preview"
          ? `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors ${frameAncestorsFor(this.allowedOrigins)}`
          : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        ...(purpose === "download" ? { "content-disposition": `attachment; filename="${safeArtifactFilename(artifact.title)}"` } : {}),
      })
      response.end(
        derived ?? (bridgeChannel && parentOrigin
          ? injectPreviewBridge(content, artifact.id, bridgeChannel, parentOrigin)
          : content),
      )
    } catch (error) {
      if (error instanceof ArtifactContentLimitError) {
        response.writeHead(413, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "artifact_limit" }))
        return
      }
      if (error instanceof PrintableArtifactError) {
        response.writeHead(error.kind === "limit" ? 413 : 422, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: error.kind === "limit" ? "artifact_limit" : "artifact_derivation_failed" }))
        return
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
    }
  }

  async #handle(socket: WebSocket, raw: string, signal?: AbortSignal): Promise<void> {
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      this.#appendPreAuthAudit("invalid-request")
      this.#error(socket, null, invalidRequest, "Request is not valid JSON")
      return
    }

    const requestResult = rpcRequestSchema.safeParse(input)
    if (!requestResult.success) {
      this.#appendPreAuthAudit("invalid-request")
      this.#error(socket, null, invalidRequest, "Request does not match JSON-RPC 2.0")
      return
    }

    const request = requestResult.data
    if (!Object.hasOwn(rpcMethods, request.method)) {
      this.#error(socket, request.id, methodNotFound, `Unknown method: ${request.method}`)
      return
    }

    const method = request.method as RpcMethod
    if (!this.#deviceCredentialActive(socket)) {
      this.#authenticatedClients.delete(socket)
      this.#appendPreAuthAudit("authentication")
      this.#rejectAuthentication(socket, request.id, "Daemon authentication failed")
      return
    }
    const paramsResult = rpcMethods[method].params.safeParse(request.params ?? {})
    if (!paramsResult.success) {
      this.#error(socket, request.id, invalidParams, "Method parameters are invalid")
      return
    }

    if (method === "system.hello") {
      if (!this.#authenticatedClients.has(socket)) {
        const supplied = "authToken" in paramsResult.data ? paramsResult.data.authToken : undefined
        if (!this.#credentialAccepted(socket, supplied)) {
          this.#appendPreAuthAudit("authentication")
          this.#rejectAuthentication(socket, request.id, "Daemon authentication failed")
          return
        }
        this.#authenticatedClients.add(socket)
      }
      const hello = paramsResult.data as RpcParams<"system.hello">
      if (this.#authenticatedActors.has(socket)) {
        this.#error(socket, request.id, invalidParams, "Connection client identity is already established")
        return
      }
      this.#authenticatedActors.set(socket, {
        kind: "client",
        client: hello.client,
        ...(hello.clientId ? { clientId: hello.clientId } : {}),
      })
      this.#connectionIds.set(socket, randomUUID())
      const deadline = this.#authenticationDeadlines.get(socket)
      if (deadline) clearTimeout(deadline)
      this.#authenticationDeadlines.delete(socket)
    } else if (method === "device.claim") {
      // The one method a machine may reach before it has a credential, because
      // presenting the pairing code is how it gets one. It grants nothing else.
      const params = rpcMethods[method].params.parse(request.params)
      if (!this.#pairing) {
        this.#error(socket, request.id, internalError, "Device pairing is unavailable")
        return
      }
      try {
        const paired = this.#pairing.claim(params.code, { label: params.label }, Date.now())
        this.#appendAudit({
          actor: { kind: "daemon", component: "rpc" },
          action: "device.claim",
          outcome: "succeeded",
          target: paired.device.id,
        })
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(paired),
        })
      } catch (error) {
        if (!(error instanceof PairingCodeError)) throw error
        // The reason is recorded for an operator but never returned: an
        // unauthenticated caller must not learn whether a code exists, has
        // expired, or was simply wrong.
        this.#appendAudit({
          actor: { kind: "daemon", component: "rpc" },
          action: "device.claim",
          outcome: "denied",
          detail: error.message,
        })
        this.#error(socket, request.id, daemonAuthenticationErrorCode, "Pairing was refused")
      }
      return
    } else if (!this.#authenticatedClients.has(socket)) {
      this.#appendPreAuthAudit("authentication")
      this.#rejectAuthentication(socket, request.id, "Daemon authentication required")
      return
    }

    if (!this.#registerAudit(socket, request.id, method, paramsResult.data)) {
      this.#appendAudit({
        actor: this.#authenticatedActors.get(socket) ?? { kind: "daemon", component: "rpc" },
        action: "security.duplicate-request-id",
        outcome: "denied",
      })
      this.#sendWithoutAudit(socket, {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: invalidRequest, message: "Request id is already in flight" },
      })
      return
    }

    try {
      let changed = false
      let alreadyPersisted = false
      if (method === "system.emergencyStop") {
        const params = paramsResult.data as RpcParams<"system.emergencyStop">
        const actor = this.#authenticatedActors.get(socket)
        const client = actor?.kind === "client" ? actor.client : params.client
        const result = await this.#enqueueEmergencyStop(client)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(result),
        })
        return
      }
      if (method === "audit.query") {
        if (!this.#auditLog) {
          this.#error(socket, request.id, invalidParams, "Audit log is unavailable")
          return
        }
        const params = paramsResult.data as RpcParams<"audit.query">
        const result = await this.#withAbortTimeout(
          async (signal) => this.#auditLog!.query(params, signal),
          this.#agentTimeoutMs,
          "Audit query timed out",
        )
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(result),
        })
        return
      }
      if (method === "session.usage") {
        const params = paramsResult.data as RpcParams<"session.usage">
        if (!this.#snapshot.sessions.some((session) => session.id === params.sessionId)) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(this.#usageLedger.session(params.sessionId)),
        })
        return
      }
      if (method === "audit.export") {
        if (!this.#auditLog) {
          this.#error(socket, request.id, invalidParams, "Audit log is unavailable")
          return
        }
        const params = paramsResult.data as RpcParams<"audit.export">
        const result = await this.#withAbortTimeout(
          async (signal) => this.#auditLog!.export(params, signal),
          this.#agentTimeoutMs,
          "Audit export timed out",
        )
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(result),
        })
        return
      }
      if (method === "terminal.create") {
        const params = paramsResult.data as RpcParams<"terminal.create">
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (session?.state === "archiving" || session?.state === "archived") {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (!session?.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        const existing = this.#terminals.get(params.terminalId)
        if (existing) {
          if (existing.sessionId !== session.id) {
            this.#error(socket, request.id, invalidParams, "Terminal belongs to another session")
            return
          }
          if (existing.owner.clientId === params.clientId) {
            existing.process.resize(params.cols, params.rows)
            existing.cols = params.cols
            existing.rows = params.rows
          }
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              terminalId: params.terminalId,
              sessionId: existing.sessionId,
              cols: existing.cols,
              rows: existing.rows,
              shell: existing.shell,
              cwd: existing.cwd,
              buffer: existing.buffer,
              owner: existing.owner,
            }),
          })
          return
        }
        const process = this.#terminalService.spawn({
          cwd: session.workspacePath,
          cols: params.cols,
          rows: params.rows,
        })
        const outputBackpressure = new TerminalOutputBackpressure(
          process,
          () => this.#maximumAuthenticatedClientBufferedBytes(),
          undefined,
          undefined,
          () => output.resume(params.terminalId),
        )
        const output = new TerminalOutputBatcher((terminalId, data) => {
          this.#broadcastNotification("terminal.output", { terminalId, data })
          return outputBackpressure.observe()
        })
        const activeTerminal: ActiveTerminal = {
          sessionId: session.id,
          process,
          cols: params.cols,
          rows: params.rows,
          shell: process.process,
          cwd: session.workspacePath,
          buffer: "",
          owner: { client: params.client, clientId: params.clientId },
          output,
          outputBackpressure,
          disposeData: () => {},
          disposeExit: () => {},
        }
        this.#terminals.set(params.terminalId, activeTerminal)
        const dataDisposable = process.onData((data) => {
          const active = this.#terminals.get(params.terminalId)
          if (active?.process === process) {
            active.buffer = `${active.buffer}${data}`.slice(-maximumTerminalReplayCharacters)
            active.output.push(params.terminalId, data)
          }
        })
        const exitDisposable = process.onExit(({ exitCode, signal }) => {
          const active = this.#terminals.get(params.terminalId)
          if (!active || active.process !== process) return
          this.#terminals.delete(params.terminalId)
          active.output.flush(params.terminalId)
          active.outputBackpressure.dispose()
          active.disposeData()
          active.disposeExit()
          this.#broadcastNotification("terminal.closed", {
            terminalId: params.terminalId,
            exitCode,
            ...(signal === undefined ? {} : { signal }),
          })
        })
        activeTerminal.disposeData = () => dataDisposable.dispose()
        activeTerminal.disposeExit = () => exitDisposable.dispose()
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            terminalId: params.terminalId,
            sessionId: session.id,
            cols: params.cols,
            rows: params.rows,
            shell: process.process,
            cwd: session.workspacePath,
            buffer: activeTerminal.buffer,
            owner: activeTerminal.owner,
          }),
        })
        return
      }

      if (method === "terminal.claim") {
        const params = paramsResult.data as RpcParams<"terminal.claim">
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        terminal.owner = { client: params.client, clientId: params.clientId }
        const ownership = rpcMethods[method].result.parse({
          terminalId: params.terminalId,
          owner: terminal.owner,
        })
        this.#broadcastNotification("terminal.ownership", ownership)
        this.#send(socket, { jsonrpc: "2.0", id: request.id, result: ownership })
        return
      }

      if (method === "terminal.input") {
        const params = paramsResult.data as RpcParams<"terminal.input">
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        terminal.process.write(params.data)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "terminal.resize") {
        const params = paramsResult.data as RpcParams<"terminal.resize">
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        terminal.process.resize(params.cols, params.rows)
        terminal.cols = params.cols
        terminal.rows = params.rows
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "terminal.close") {
        const params = paramsResult.data as RpcParams<"terminal.close">
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        this.#closeTerminal(params.terminalId)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "artifact.authorize") {
        const params = paramsResult.data as RpcParams<"artifact.authorize">
        const artifact = this.#snapshot.artifacts.find(
          (candidate) => candidate.id === params.artifactId
            && candidate.sessionId === params.sessionId
            && candidate.revision === params.revision
            && candidate.type === "preview",
        )
        if (!artifact || artifact.mimeType !== "text/html" || !artifact.path) {
          this.#error(socket, request.id, invalidParams, "Preview artifact does not exist")
          return
        }
        const expiresAt = Math.floor(Date.now() / 1_000) + this.#artifactAccessTtlSeconds
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            sessionId: params.sessionId,
            artifactId: params.artifactId,
            revision: params.revision,
            purpose: params.purpose,
            ...(params.bridgeChannel ? { bridgeChannel: params.bridgeChannel } : {}),
            expiresAt,
            signature: signArtifactAccess(
              this.#artifactSigningSecret,
              {
                sessionId: params.sessionId,
                artifactId: params.artifactId,
                revision: params.revision,
                purpose: params.purpose,
                ...(params.bridgeChannel ? { bridgeChannel: params.bridgeChannel } : {}),
                expiresAt,
              },
            ),
          }),
        })
        return
      }

      if (method === "runtime.models") {
        const params = paramsResult.data as RpcParams<"runtime.models">
        let models: ProviderModel[]
        try {
          models = await this.#listProviderModels(params.provider)
        } catch (error) {
          if (!(error instanceof AgentProviderUnavailableError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(models),
        })
        return
      }

      if (method === "provider.refresh") {
        if (!this.#providerProbe) {
          this.#error(socket, request.id, invalidParams, "Provider diagnostics are unavailable")
          return
        }
        try {
          await this.#queueProviderRefresh(false)
        } catch (error) {
          this.#reportError("Domovoi could not refresh provider runtimes", error)
          this.#error(socket, request.id, internalError, "Provider diagnostics could not be refreshed")
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(workspaceSnapshotForClient(this.#snapshot)),
        })
        return
      }

      if (method === "provider.secret.list") {
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(this.#providerSecrets.status()),
        })
        return
      }

      if (method === "skill.list") {
        const catalog = this.#skillCatalog ?? new FileSkillCatalog(
          skillRoots(homedir(), this.#snapshot.project?.path),
        )
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(await catalog.list()),
        })
        return
      }

      if (method === "device.saveCredential") {
        const params = rpcMethods[method].params.parse(request.params)
        // Keeping another machine's credential is device management, so a
        // device credential must not reach it.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Managing paired devices requires the daemon credential",
          )
          return
        }
        if (!this.#machineCredentials) {
          this.#error(socket, request.id, internalError, "Machine credentials are unavailable")
          return
        }
        this.#machineCredentials.save(params.machineId, params.credential)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ saved: true }),
        })
        return
      }

      if (method === "session.transfer") {
        const params = rpcMethods[method].params.parse(request.params)
        // Moving a session hands a worktree to another machine, so a device
        // credential must not reach it.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Moving a session requires the daemon credential",
          )
          return
        }
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        const canSend = params.method === "remote-ref"
          ? this.#workspaceService.pushSessionRef !== undefined
          : this.#workspaceService.bundleSession !== undefined && this.#readTransferBundle !== undefined
        if (!canSend) {
          this.#error(socket, request.id, internalError, "This machine cannot send transfers")
          return
        }

        const fleet = this.#store.fleet?.snapshot(this.#snapshot.machine.id, Date.now())
        const target = fleet?.machines.find((machine) => machine.id === params.targetMachineId)
        if (!target) {
          // A machine this daemon cannot see is a machine it cannot reach now,
          // and a transfer is refused rather than queued.
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              outcome: "refused",
              reason: "target-unreachable",
            }),
          })
          return
        }

        // Nothing reaches for the other machine until the transfer is allowed:
        // an ineligible session or an unusable target is settled here.
        const sourceReady = sourcePreflight({ session })
        if (!sourceReady.allowed) {
          this.#recordTransferRefusal(session.id, target.id, params.client, sourceReady.reason)
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              outcome: "refused",
              reason: sourceReady.reason,
            }),
          })
          return
        }
        const targetReady = transferPreflight({
          source: { ...target, id: this.#snapshot.machine.id },
          target,
        })
        if (!targetReady.allowed) {
          this.#recordTransferRefusal(session.id, target.id, params.client, targetReady.reason)
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              outcome: "refused",
              reason: targetReady.reason,
            }),
          })
          return
        }

        // A target that stops answering must not hold this request open, and a
        // cancelled request must not keep talking to the other machine.
        const transferDeadline = new AbortController()
        const timeout = setTimeout(() => transferDeadline.abort(), this.#sessionTransferTimeoutMs)
        timeout.unref?.()
        const transferSignal = signal
          ? AbortSignal.any([signal, transferDeadline.signal])
          : transferDeadline.signal
        const connection = await this.#connectToMachine(target.id, transferSignal)
        try {
          if (params.method === "remote-ref") {
            const outcome = await sendSessionThroughRemote({
              session,
              sourceMachineId: this.#snapshot.machine.id,
              target,
              client: params.client,
              remote: params.remote!,
              call: (remoteMethod, remoteParams) =>
                connection.call(remoteMethod, remoteParams, transferSignal),
              // The git work runs under the transfer's own deadline, so a call
              // that hangs cannot outlive the transfer and hold the queue.
              checkpoint: (worktreePath, label) =>
                this.#workspaceService.checkpoint(worktreePath, label, transferSignal),
              pushSessionRef: this.#workspaceService.pushSessionRef
                ? (worktreePath, remote, sessionId) =>
                  this.#workspaceService.pushSessionRef!(
                    worktreePath,
                    remote,
                    sessionId,
                    transferSignal,
                  )
                : undefined,
              recordReceipt: (receipt) => {
                try {
                  this.#store.transferReceipts?.record(receipt)
                } catch (error) {
                  this.#reportError("Domovoi could not record a transfer receipt", error)
                }
              },
              now: () => new Date().toISOString(),
            })
            this.#send(socket, {
              jsonrpc: "2.0",
              id: request.id,
              result: rpcMethods[method].result.parse(outcome),
            })
            return
          }
          const readBundle = this.#readTransferBundle
          const bundleSession = this.#workspaceService.bundleSession
          if (!readBundle || !bundleSession) {
            this.#error(socket, request.id, internalError, "This machine cannot send transfers")
            return
          }
          const outcome = await sendSessionToMachine({
            session,
            sourceMachineId: this.#snapshot.machine.id,
            target,
            client: params.client,
            call: (remoteMethod, remoteParams) =>
              connection.call(remoteMethod, remoteParams, transferSignal),
            checkpoint: (worktreePath, label) =>
              this.#workspaceService.checkpoint(worktreePath, label, transferSignal),
            bundleSession: (worktreePath, bundlePath) =>
              bundleSession(worktreePath, bundlePath, undefined, transferSignal),
            readBundle,
            recordReceipt: (receipt) => {
              // The receipt records what happened; it does not decide it. A
              // daemon that cannot store one still answers with the outcome.
              try {
                this.#store.transferReceipts?.record(receipt)
              } catch (error) {
                this.#reportError("Domovoi could not record a transfer receipt", error)
              }
            },
            now: () => new Date().toISOString(),
          })
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse(outcome),
          })
        } finally {
          clearTimeout(timeout)
          connection.close()
        }
        return
      }

      if (method === "transfer.have") {
        const params = rpcMethods[method].params.parse(request.params)
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Accepting a session transfer requires the daemon credential",
          )
          return
        }
        const held = await this.#workspaceService.sessionHeadCommit?.(params.sessionId, signal)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(held ? { commit: held } : {}),
        })
        return
      }

      if (method === "transfer.fromRef") {
        const params = rpcMethods[method].params.parse(request.params)
        // Taking a session writes a worktree here, which is machine management.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Accepting a session transfer requires the daemon credential",
          )
          return
        }
        const repositoryPath = this.#snapshot.project?.path
        if (!this.#workspaceService.restoreSessionFromRef || !repositoryPath) {
          this.#error(socket, request.id, internalError, "This machine cannot take a session from a remote")
          return
        }
        const workspace = await this.#workspaceService.restoreSessionFromRef(
          repositoryPath,
          params.remote,
          params.sessionId,
          signal,
        )
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            workspacePath: workspace.path,
            checkpointCommit: workspace.baseCommit,
          }),
        })
        return
      }

      if (method === "transfer.begin" || method === "transfer.chunk") {
        // Accepting a session writes a worktree on this machine, which is
        // machine management, so a device credential must not reach it.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Accepting a session transfer requires the daemon credential",
          )
          return
        }
        if (!this.#workspaceService.restoreSessionFromBundle) {
          this.#error(socket, request.id, internalError, "This machine cannot accept transfers")
          return
        }

        if (method === "transfer.begin") {
          const params = rpcMethods[method].params.parse(request.params)
          if (this.#incomingTransfers.size >= maximumIncomingTransfers) {
            this.#error(socket, request.id, invalidParams, "Too many transfers are already arriving")
            return
          }
          const transferId = `transfer-${randomBytes(16).toString("hex")}`
          this.#incomingTransfers.set(transferId, {
            sessionId: params.sessionId,
            assembler: new TransferAssembler({
              digest: params.digest,
              totalBytes: params.totalBytes,
            }),
            socket,
            idle: this.#scheduleTransferExpiry(transferId),
          })
          // A source that stops sending, or goes away, must not hold a slot
          // that other machines need.
          socket.once("close", () => this.#forgetTransfersFrom(socket))
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({ transferId }),
          })
          return
        }

        const params = rpcMethods[method].params.parse(request.params)
        const incoming = this.#incomingTransfers.get(params.transferId)
        if (!incoming) {
          this.#error(socket, request.id, invalidParams, "That transfer is not arriving")
          return
        }
        clearTimeout(incoming.idle)
        incoming.idle = this.#scheduleTransferExpiry(params.transferId)
        const accepted = incoming.assembler.accept(params)
        if (accepted.state === "refused") {
          this.#forgetTransfer(params.transferId)
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse(accepted),
          })
          return
        }
        if (accepted.state === "receiving") {
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse(accepted),
          })
          return
        }

        // The bundle is only reported as restored once it actually is, so the
        // source never learns a session moved before it did.
        this.#forgetTransfer(params.transferId)
        const directory = await mkdtemp(join(tmpdir(), "domovoi-transfer-"))
        const bundlePath = join(directory, "session.bundle")
        try {
          await writeFile(bundlePath, incoming.assembler.bytes(), { mode: 0o600 })
          const workspace = await this.#workspaceService.restoreSessionFromBundle(
            bundlePath,
            incoming.sessionId,
            signal,
          )
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              state: "restored",
              workspacePath: workspace.path,
              checkpointCommit: workspace.baseCommit,
            }),
          })
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
        return
      }

      if (method === "device.machineCredential") {
        const params = rpcMethods[method].params.parse(request.params)
        // Handing out another machine's credential is device management, so a
        // device credential must not reach it.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Managing paired devices requires the daemon credential",
          )
          return
        }
        if (!this.#machineCredentials) {
          this.#error(socket, request.id, internalError, "Machine credentials are unavailable")
          return
        }
        const credential = this.#machineCredentials.forMachine(params.machineId)
        if (credential === undefined) {
          this.#error(
            socket,
            request.id,
            machineCredentialMissingErrorCode,
            "No credential is kept for that machine",
          )
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ credential }),
        })
        return
      }

      if (method === "device.issueCode") {
        rpcMethods[method].params.parse(request.params)
        // Opening a pairing enrols a new device, so it is device management and
        // a device credential must not reach it: otherwise one paired device
        // could mint codes and enrol more.
        if (this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Managing paired devices requires the daemon credential",
          )
          return
        }
        if (!this.#pairing) {
          this.#error(socket, request.id, internalError, "Device pairing is unavailable")
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(this.#pairing.issue(Date.now())),
        })
        return
      }

      if (
        method === "device.pair"
        || method === "device.list"
        || method === "device.revoke"
        || method === "device.rotate"
      ) {
        const params = rpcMethods[method].params.parse(request.params)
        const devices = this.#store.devices
        if (!devices) {
          this.#error(socket, request.id, internalError, "Device pairing is unavailable")
          return
        }
        // A stolen device credential must not be able to mint more devices or
        // withdraw the ones that would reveal it.
        if (method !== "device.list" && this.#deviceCredentials.get(socket) !== undefined) {
          this.#error(
            socket,
            request.id,
            daemonAuthenticationErrorCode,
            "Managing paired devices requires the daemon credential",
          )
          return
        }
        const result = method === "device.pair"
          ? devices.pair({ label: (params as { label: string }).label })
          : method === "device.list"
            ? { devices: devices.list() }
            : method === "device.revoke"
              ? { device: devices.revoke((params as { deviceId: string }).deviceId) }
              : devices.rotate((params as { deviceId: string }).deviceId)
        if (method === "device.revoke" || method === "device.rotate") {
          this.#disconnectInactiveDevices()
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(result),
        })
        return
      }

      if (method === "fleet.list") {
        rpcMethods[method].params.parse(request.params)
        this.#recordThisMachine()
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(
            this.#store.fleet?.snapshot(this.#snapshot.machine.id, Date.now())
              ?? { machines: [] },
          ),
        })
        return
      }

      if (method === "skill.inventory") {
        const catalog = this.#skillCatalog ?? new FileSkillCatalog(
          skillRoots(homedir(), this.#snapshot.project?.path),
        )
        const machine = this.#snapshot.machine
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            machine: {
              id: machine.id,
              name: machine.name,
              platform: machine.platform,
              arch: machine.arch,
              version: machine.version,
            },
            skills: (await catalog.list()).map(skillInventoryEntryFromSummary),
          }),
        })
        return
      }

      if (method === "skill.read") {
        const params = paramsResult.data as RpcParams<"skill.read">
        const catalog = this.#skillCatalog ?? new FileSkillCatalog(
          skillRoots(homedir(), this.#snapshot.project?.path),
        )
        try {
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse(await catalog.read(params.id)),
          })
        } catch (error) {
          if (!(error instanceof SkillNotFoundError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
        }
        return
      }

      if (method === "skill.setEnabled") {
        const params = paramsResult.data as RpcParams<"skill.setEnabled">
        const project = this.#snapshot.project
        if (!project) {
          this.#error(socket, request.id, invalidParams, "Open a project before reviewing skills")
          return
        }
        const actor = this.#authenticatedActors.get(socket)
        if (!actor || actor.kind !== "client") {
          this.#error(socket, request.id, invalidParams, "Skill review requires an identified client")
          return
        }
        const catalog = this.#skillCatalog ?? new FileSkillCatalog(
          skillRoots(homedir(), project.path),
        )
        let current
        try {
          current = (await catalog.read(params.id)).skill
        } catch (error) {
          if (!(error instanceof SkillNotFoundError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        if (params.enabled && current.trust.state === "blocked") {
          this.#error(socket, request.id, invalidParams, "Blocked skills cannot be enabled")
          return
        }
        if (current.contentDigest !== params.contentDigest) {
          this.#error(socket, request.id, invalidParams, "Skill content changed; review it again")
          return
        }
        if (JSON.stringify(current.manifest) !== JSON.stringify(params.manifest)) {
          this.#error(socket, request.id, invalidParams, "Skill capabilities changed; review them again")
          return
        }
        const review = {
          projectId: project.id,
          skillId: current.id,
          enabled: params.enabled,
          contentDigest: current.contentDigest,
          manifest: current.manifest,
          reviewedAt: new Date().toISOString(),
          reviewedBy: {
            client: actor.client,
            ...(actor.clientId ? { clientId: actor.clientId } : {}),
          },
        }
        this.#snapshot.skillEnablements = this.#snapshot.skillEnablements.filter(
          (candidate) => candidate.projectId !== project.id || candidate.skillId !== current.id,
        )
        this.#snapshot.skillEnablements.push(review)
        changed = true
      }

      if (method === "session.history") {
        const params = paramsResult.data as RpcParams<"session.history">
        if (!this.#snapshot.sessions.some((session) => session.id === params.sessionId)) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        const page = this.#sessionHistory.page(this.#snapshot, params, signal)
        if (!page) {
          this.#error(socket, request.id, invalidParams, "History cursor does not exist")
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(page),
        })
        return
      }

      if (method === "session.evidence") {
        const params = paramsResult.data as RpcParams<"session.evidence">
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        if (!session.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        if (!this.#workspaceService.evidence) {
          this.#error(socket, request.id, invalidParams, "Session evidence is unavailable")
          return
        }
        let workspace
        try {
          workspace = await this.#withAbortTimeout(
            (signal) => this.#workspaceService.evidence!(session.workspacePath!, signal),
            this.#agentTimeoutMs,
            "Session evidence timed out",
          )
        } catch (error) {
          if (error instanceof WorkspaceEvidenceUnstableError) {
            throw new PublicRpcError(internalError, error.message)
          }
          throw error
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            sessionId: session.id,
            refreshedAt: new Date().toISOString(),
            workspace,
            tests: testEvidence(this.#snapshot.thread.filter(
              (item) => item.sessionId === session.id,
            )),
          }),
        })
        return
      }

      if (method === "system.pauseAll") {
        const params = paramsResult.data as RpcParams<"system.pauseAll">
        changed = await this.#pauseSessions(this.#snapshot.sessions.filter(
          (session) => !sessionIsArchiveReadOnly(session)
            && session.providerThreadId
            && session.activeTurnId,
        ), params.client)
      }

      if (method === "session.pause") {
        const params = paramsResult.data as RpcParams<"session.pause">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        changed = await this.#pauseSessions(
          session.providerThreadId && session.activeTurnId ? [session] : [],
          params.client,
        )
      }

      if (method === "session.archive") {
        const params = paramsResult.data as RpcParams<"session.archive">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        await this.#archiveSession(session.id, params.client)
        changed = true
      }

      if (method === "annotation.create") {
        const params = paramsResult.data as RpcParams<"annotation.create">
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        const artifact = this.#snapshot.artifacts.find(
          (candidate) =>
            candidate.id === params.artifactId && candidate.sessionId === params.sessionId,
        )
        if (!artifact) {
          this.#error(socket, request.id, invalidParams, "Artifact does not belong to the session")
          return
        }
        if (
          params.visualContextUpload
          && params.visualContextUpload.artifactRevision !== artifact.revision
        ) {
          this.#error(socket, request.id, invalidParams, "Visual context revision is stale")
          return
        }
        let visualContext: Annotation["visualContext"]
        if (params.visualContextUpload) {
          const decodedByteLength = canonicalBase64DecodedByteLength(params.visualContextUpload.data)
          const bytes = decodedByteLength === undefined
            ? undefined
            : Buffer.from(params.visualContextUpload.data, "base64")
          if (
            !bytes
            || bytes.byteLength !== decodedByteLength
            || bytes.toString("base64") !== params.visualContextUpload.data
          ) {
            this.#error(socket, request.id, invalidParams, "Visual context data is invalid")
            return
          }
          visualContext = await this.#annotationVisualContext.storeUpload({
            artifactRevision: artifact.revision,
            mimeType: params.visualContextUpload.mimeType,
            bytes: new Uint8Array(bytes),
            width: params.visualContextUpload.width,
            height: params.visualContextUpload.height,
          })
        } else if (
          artifact.type === "preview"
          && artifact.mimeType === "text/html"
          && artifact.path
          && session?.workspacePath
        ) {
          const htmlPath = await resolveInsideReal(session.workspacePath, artifact.path)
          visualContext = htmlPath
            ? await this.#annotationVisualContext.capture({
                artifactId: artifact.id,
                artifactRevision: artifact.revision,
                htmlPath,
                ...(params.anchor.bbox ? { bbox: params.anchor.bbox } : {}),
              })
            : { status: "unavailable", artifactRevision: artifact.revision, reason: "artifact-unavailable" }
        } else {
          visualContext = {
            status: "unavailable",
            artifactRevision: artifact.revision,
            reason: params.anchor.bbox ? "artifact-unavailable" : "missing-bounds",
          }
        }
        const createdAt = new Date().toISOString()
        this.#snapshot.annotations.push({
          id: `annotation-${randomUUID()}`,
          sessionId: params.sessionId,
          artifactId: params.artifactId,
          ...(params.variantId ? { variantId: params.variantId } : {}),
          anchor: params.anchor,
          body: params.body,
          status: "open",
          origin: params.client,
          visualContext,
          thread: [],
          createdAt,
          updatedAt: createdAt,
        })
        changed = true
      }

      if (method === "annotation.reply") {
        const params = paramsResult.data as RpcParams<"annotation.reply">
        const annotation = this.#snapshot.annotations.find(
          (candidate) => candidate.id === params.annotationId,
        )
        if (!annotation) {
          this.#error(socket, request.id, invalidParams, "Annotation does not exist")
          return
        }
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === annotation.sessionId,
        )
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        const createdAt = new Date().toISOString()
        annotation.thread.push({
          id: `annotation-reply-${randomUUID()}`,
          body: params.body,
          origin: params.client,
          createdAt,
        })
        annotation.updatedAt = createdAt
        changed = true
      }

      if (method === "annotation.setStatus") {
        const params = paramsResult.data as RpcParams<"annotation.setStatus">
        const annotation = this.#snapshot.annotations.find(
          (candidate) => candidate.id === params.annotationId,
        )
        if (!annotation) {
          this.#error(socket, request.id, invalidParams, "Annotation does not exist")
          return
        }
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === annotation.sessionId,
        )
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        const changedAt = new Date().toISOString()
        annotation.status = params.status
        annotation.statusChangedBy = params.client
        annotation.statusChangedAt = changedAt
        annotation.updatedAt = changedAt
        changed = true
      }

      if (method === "approval.resolve") {
        const params = rpcMethods[method].params.parse(request.params)
        const actor = this.#authenticatedActors.get(socket)
        const connectionId = this.#connectionIds.get(socket)
        if (!actor || actor.kind !== "client" || !connectionId) {
          this.#error(socket, request.id, invalidParams, "Approval resolution requires an authenticated connection identity")
          return
        }
        const approval = this.#snapshot.approvals.find(
          (candidate) => candidate.id === params.approvalId,
        )
        if (!approval) {
          this.#error(socket, request.id, invalidParams, "Approval does not exist")
          return
        }
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === approval.sessionId,
        )
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (approval.risk === "hard-gate" && params.decision === "always-project") {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Hard-gate approvals cannot create standing rules",
          )
          return
        }
        if (approval.providerRequestId !== undefined && session) {
          this.#agents.require(session.runtime.provider)
            .resolveApproval(approval.providerRequestId, params.decision)
        }
        if (params.decision === "always-project") {
          const project = this.#snapshot.project
          if (!project) {
            this.#error(socket, request.id, internalError, "Approval has no open project")
            return
          }
          this.#snapshot.approvalRules.push({
            id: `rule-${approval.id}-${Date.now()}`,
            projectId: project.id,
            operation: approval.operation,
            command: approval.command,
            createdBy: actor.client,
            createdByConnectionId: connectionId,
            createdAt: new Date().toISOString(),
          })
        }
        this.#snapshot.thread.push({
          id: `receipt-${approval.id}-${Date.now()}`,
          sessionId: approval.sessionId,
          kind: "receipt",
          decision: params.decision,
          operation: approval.operation,
          checkpoint: approval.checkpoint,
          client: actor.client,
          connectionId,
          ...(params.explanation
            ? { explanation: redactDurableText(params.explanation).value }
            : {}),
          createdAt: new Date().toISOString(),
        })
        this.#snapshot.approvals = this.#snapshot.approvals.filter(
          (approval) => approval.id !== params.approvalId,
        )
        if (session) {
          session.state = params.decision === "deny" || params.decision === "deny-explain"
            ? "idle"
            : "active"
        }
        changed = true
      }

      if (method === "session.setRuntime") {
        const params = paramsResult.data as RpcParams<"session.setRuntime">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        const crossesAskBoundary = (session.runtime.permissionMode === "ask")
          !== (params.runtime.permissionMode === "ask")
        if (session.activeTurnId && crossesAskBoundary) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Stop the active turn before entering or leaving Ask mode",
          )
          return
        }
        const providerChanged = params.runtime.provider !== session.runtime.provider
        const currentThreadKey = session.providerThreadId
          ? providerThreadKey(session.runtime.provider, session.providerThreadId)
          : undefined
        const recoveringEmergencyThread = currentThreadKey !== undefined
          && this.#failedEmergencyThreads.has(currentThreadKey)
        const replacesThread = providerChanged || recoveringEmergencyThread
        if (replacesThread && (!session.workspacePath || !session.providerThreadId)) {
          this.#error(socket, request.id, invalidParams, "Session is not ready for provider handoff")
          return
        }
        if (replacesThread && session.activeTurnId) {
          this.#error(socket, request.id, invalidParams, "Stop the active turn before changing providers")
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        const previousKey = currentSession.providerThreadId
          ? providerThreadKey(currentSession.runtime.provider, currentSession.providerThreadId)
          : undefined
        const recoveringFailedThread = previousKey !== undefined
          && this.#failedEmergencyThreads.has(previousKey)
        if (runtime.provider !== currentSession.runtime.provider || recoveringFailedThread) {
          if (!currentSession.workspacePath || !currentSession.providerThreadId) {
            this.#error(socket, request.id, invalidParams, "Session is not ready for provider handoff")
            return
          }
          const previousRuntime = currentSession.runtime
          const previousThreadId = currentSession.providerThreadId
          const nextAgent = await this.#ensureAgentConnected(runtime.provider)
          const startNextThread = async () => {
            signal?.throwIfAborted()
            const nextThreadId = await withLateCleanup(
              nextAgent.startThread({ cwd: currentSession.workspacePath!, runtime }),
              this.#agentTimeoutMs,
              recoveringFailedThread ? "Provider recovery timed out" : "Provider handoff timed out",
              (threadId) => nextAgent.stopThread(threadId),
              "Domovoi could not stop a late replacement provider thread",
              (context, error) => this.#reportError(context, error),
            )
            if (signal?.aborted) {
              await withTimeout(
                nextAgent.stopThread(nextThreadId),
                this.#agentTimeoutMs,
                "Cancelled provider replacement cleanup timed out",
              )
              signal.throwIfAborted()
            }
            return nextThreadId
          }
          let checkpoint: Awaited<ReturnType<WorkspaceService["checkpoint"]>>
          const nextThreadId = await startNextThread()
          try {
            checkpoint = await this.#withAbortTimeout(
              (signal) => this.#workspaceService.checkpoint(
                currentSession.workspacePath!,
                recoveringFailedThread ? "before provider recovery" : "before provider handoff",
                signal,
              ),
              this.#agentTimeoutMs,
              recoveringFailedThread
                ? "Provider recovery checkpoint timed out"
                : "Provider handoff checkpoint timed out",
            )
            await withTimeout(
              this.#agents.require(previousRuntime.provider).stopThread(previousThreadId),
              this.#agentTimeoutMs,
              recoveringFailedThread
                ? "Failed provider cleanup timed out"
                : "Previous provider cleanup timed out",
            )
          } catch (error) {
            try {
              await nextAgent.stopThread(nextThreadId)
            } catch (cleanupError) {
              this.#reportError("Domovoi could not stop a failed handoff thread", cleanupError)
            }
            throw error
          }
          const createdAt = new Date().toISOString()
          currentSession.runtime = runtime
          currentSession.providerThreadId = nextThreadId
          currentSession.changedFiles = checkpoint.changedFiles.length
          currentSession.state = "idle"
          currentSession.updatedAt = createdAt
          delete currentSession.providerFailure
          this.#loadedAgentThreads.delete(providerThreadKey(previousRuntime.provider, previousThreadId))
          this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, nextThreadId))
          if (recoveringFailedThread && previousKey) {
            this.#failedEmergencyThreads.delete(previousKey)
            this.#emergencyBlockedThreads.delete(previousKey)
          }
          this.#snapshot.thread.push({
            id: `checkpoint-${randomUUID()}`,
            sessionId: currentSession.id,
            kind: "checkpoint",
            label: `${checkpoint.commit.slice(0, 8)} · before provider ${recoveringFailedThread ? "recovery" : "handoff"}`,
            commit: checkpoint.commit,
            createdAt,
          })
          const openAnnotationCount = this.#snapshot.annotations.filter(
            (annotation) => annotation.sessionId === currentSession.id && annotation.status === "open",
          ).length
          this.#snapshot.thread.push({
            id: `handoff-${randomUUID()}`,
            sessionId: currentSession.id,
            kind: "system",
            body: recoveringFailedThread
              ? `Recovered ${runtime.provider} / ${runtime.model} with a replacement provider thread.`
              : `Handed off ${previousRuntime.provider} / ${previousRuntime.model} to ${runtime.provider} / ${runtime.model}.`,
            detail: recoveringFailedThread
              ? `Checkpoint, plan, worktree, diff, test results, and ${openAnnotationCount} open annotations were preserved. The failed provider thread was quarantined. Hidden reasoning and provider caches did not transfer.`
              : `Thread, plan, worktree, diff, test results, and ${openAnnotationCount} open annotations carried over. Hidden reasoning and provider caches did not transfer.`,
            createdAt,
          })
        } else {
          currentSession.runtime = runtime
          delete currentSession.providerFailure
        }
        changed = true
      }

      if (method === "session.restartProviderThread") {
        const params = rpcMethods[method].params.parse(request.params)
        const authenticatedActor = this.#authenticatedActors.get(socket)
        const connectionId = this.#connectionIds.get(socket)
        if (!authenticatedActor || authenticatedActor.kind !== "client" || !connectionId) {
          this.#error(socket, request.id, invalidParams, "Provider restart requires an authenticated connection identity")
          return
        }
        const client = authenticatedActor.client
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        if (sessionIsArchiveReadOnly(session)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (!session.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        if (session.providerThreadId) {
          this.#error(socket, request.id, invalidParams, "Session already has a live provider thread")
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime ?? session.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        const agent = await this.#ensureAgentConnected(runtime.provider)
        const threadId = await withLateCleanup(
          agent.startThread({ cwd: session.workspacePath, runtime }),
          this.#agentTimeoutMs,
          "Provider restart timed out",
          (lateThreadId) => agent.stopThread(lateThreadId),
          "Domovoi could not stop a late restarted provider thread",
          (context, error) => this.#reportError(context, error),
        )
        try {
          if (signal?.aborted) {
            await withTimeout(
              agent.stopThread(threadId),
              this.#agentTimeoutMs,
              "Cancelled provider restart cleanup timed out",
            )
            signal.throwIfAborted()
          }
          const candidate = structuredClone(this.#snapshot)
          const currentSession = candidate.sessions.find(({ id }) => id === params.sessionId)
          if (!currentSession || !currentSession.workspacePath || currentSession.providerThreadId) {
            throw new PublicRpcError(invalidParams, "Session is no longer ready to restart its provider")
          }
          const createdAt = new Date().toISOString()
          currentSession.runtime = runtime
          currentSession.providerThreadId = threadId
          currentSession.state = "idle"
          currentSession.updatedAt = createdAt
          delete currentSession.activeTurnId
          delete currentSession.providerFailure
          candidate.thread.push({
            id: `system-${randomUUID()}`,
            sessionId: currentSession.id,
            kind: "system",
            body: `Provider thread restarted by ${client}.`,
            detail: `Connection ${connectionId}. The existing worktree, history, checkpoints, artifacts, and annotations were preserved.`,
            createdAt,
          })
          workspaceSnapshotSchema.parse(candidate)
          this.#store.save(candidate)
          this.#snapshot = candidate
          this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, threadId))
          changed = true
          alreadyPersisted = true
        } catch (error) {
          try {
            await withTimeout(
              agent.stopThread(threadId),
              this.#agentTimeoutMs,
              "Failed provider restart cleanup timed out",
            )
          } catch (cleanupError) {
            this.#reportError("Domovoi could not stop a failed restarted provider thread", cleanupError)
          }
          throw error
        }
      }

      if (method === "project.open") {
        const params = paramsResult.data as RpcParams<"project.open">
        const repository = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.inspect(params.path, signal),
          this.#agentTimeoutMs,
          "Repository inspection timed out",
        )
        const projectId = `project-${createHash("sha256").update(repository.root).digest("hex").slice(0, 12)}`
        if (this.#snapshot.project?.path === repository.root) {
          if (
            this.#snapshot.project.name !== repository.name
            || this.#snapshot.project.branch !== repository.branch
          ) {
            this.#snapshot.project = {
              ...this.#snapshot.project,
              name: repository.name,
              branch: repository.branch,
            }
            changed = true
          }
        } else {
          const sessions = this.#snapshot.sessions.map((session) => ({
            id: session.id,
            title: session.title,
            state: session.state,
            ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
          }))
          const confirmation: ProjectSwitchConfirmation = {
            kind: "project-switch-confirmation",
            requestedPath: repository.root,
            sessions,
            sessionCount: sessions.length,
            worktreeCount: sessions.filter((session) => session.workspacePath).length,
          }
          if (
            sessions.length > 0
            && JSON.stringify(params.confirmation) !== JSON.stringify(confirmation)
          ) {
            this.#error(
              socket,
              request.id,
              projectSwitchConfirmationErrorCode,
              "Confirm session removal before switching projects",
              confirmation,
            )
            return
          }
          this.#closeAllTerminals()
          for (const session of this.#snapshot.sessions) {
            this.#flushCommandOutputStreams(session.id)
          }
          await this.#cleanupSessions()
          this.#commandOutputRedactors.clear()
          this.#snapshot.project = {
            id: projectId,
            machineId: this.#snapshot.machine.id,
            name: repository.name,
            path: repository.root,
            branch: repository.branch,
          }
          this.#snapshot.sessions = []
          this.#snapshot.activeSessionId = null
          this.#snapshot.approvals = []
          this.#snapshot.approvalRules = []
          this.#snapshot.thread = []
          this.#snapshot.artifacts = []
          this.#snapshot.annotations = []
          changed = true
        }
      }

      if (method === "session.activate") {
        const params = paramsResult.data as RpcParams<"session.activate">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        this.#snapshot.activeSessionId = session.id
        changed = true
      }

      if (method === "session.create") {
        const params = paramsResult.data as RpcParams<"session.create">
        const project = this.#snapshot.project
        if (!project) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Open a valid Git repository with project.open before creating a session",
          )
          return
        }
        try {
          await this.#withAbortTimeout(
            (signal) => this.#workspaceService.inspect(project.path, signal),
            this.#agentTimeoutMs,
            "Repository inspection timed out",
          )
        } catch (error) {
          if (error instanceof OperationTimeoutError) throw error
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Open a valid Git repository with project.open before creating a session",
          )
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        const sessionId = `session-${randomUUID()}`
        const workspace = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.createSessionWorkspace(
            project.path,
            sessionId,
            signal,
          ),
          this.#agentTimeoutMs,
          "Session workspace creation timed out",
        )
        let providerThreadId: string
        try {
          const agent = this.#agents.require(runtime.provider)
          const pendingThread = agent.startThread({ cwd: workspace.path, runtime })
          providerThreadId = await withLateCleanup(
            pendingThread,
            this.#agentTimeoutMs,
            "Agent setup timed out",
            (threadId) => agent.stopThread(threadId),
            "Domovoi could not stop a late session thread",
            (context, error) => this.#reportError(context, error),
          )
          if (signal?.aborted) {
            await withTimeout(
              agent.stopThread(providerThreadId),
              this.#agentTimeoutMs,
              "Cancelled session thread cleanup timed out",
            )
            signal.throwIfAborted()
          }
        } catch (error) {
          try {
            await this.#withAbortTimeout(
              (signal) => this.#workspaceService.removeSessionWorkspace(workspace.path, signal),
              this.#agentTimeoutMs,
              "Session workspace cleanup timed out",
            )
          } catch (cleanupError) {
            this.#reportError("Domovoi could not remove a failed session worktree", cleanupError)
          }
          throw error
        }
        const createdAt = new Date().toISOString()
        this.#snapshot.sessions.push({
          id: sessionId,
          projectId: project.id,
          title: params.title,
          state: "idle",
          runtime,
          changedFiles: 0,
          testsPassed: 0,
          testsFailed: 0,
          updatedAt: createdAt,
          workspacePath: workspace.path,
          providerThreadId,
          baseCommit: workspace.baseCommit,
        })
        this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, providerThreadId))
        this.#snapshot.activeSessionId = sessionId
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId,
          kind: "system",
          body: `Created isolated worktree ${workspace.branch}.`,
          detail: workspace.path,
          createdAt,
        })
        changed = true
      }

      if (method === "session.fork") {
        const params = paramsResult.data as RpcParams<"session.fork">
        const existingFork = this.#snapshot.sessions.find(
          (candidate) => candidate.forkedFrom?.requestId === params.requestId,
        )
        if (existingFork) {
          const sameRuntime = Object.entries(params.runtime).every(
            ([key, value]) => existingFork.forkedFrom?.requestedRuntime[key as keyof Runtime] === value,
          )
          if (
            existingFork.forkedFrom?.sourceSessionId !== params.sessionId
            || existingFork.forkedFrom.checkpointId !== params.checkpointId
            || !sameRuntime
          ) {
            this.#error(
              socket,
              request.id,
              invalidParams,
              "Fork request ID conflicts with an existing fork",
            )
            return
          }
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: workspaceSnapshotForClient(this.#snapshot),
          })
          return
        }

        const source = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!source) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        if (sessionIsArchiveReadOnly(source)) {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (source.activeTurnId || source.state === "active") {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Stop the active turn before forking a session",
          )
          return
        }
        if (source.state === "waiting") {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Wait for the pending session mutation before forking",
          )
          return
        }
        if (!source.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session is not ready to fork")
          return
        }
        const checkpoint = this.#snapshot.thread.find(
          (candidate) => candidate.id === params.checkpointId
            && candidate.sessionId === source.id
            && candidate.kind === "checkpoint",
        )
        if (!checkpoint || checkpoint.kind !== "checkpoint" || !checkpoint.commit) {
          this.#error(socket, request.id, invalidParams, "Checkpoint is not durable for this session")
          return
        }
        const readiness = this.#snapshot.machine.providers.find(
          (provider) => provider.id === params.runtime.provider,
        )
        if (readiness && (readiness.status !== "ready" || !readiness.sessionCapable)) {
          this.#error(socket, request.id, invalidParams, "Provider is not ready to fork a session")
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        if (!this.#workspaceService.createSessionWorkspaceFromCheckpoint) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Checkpoint forks are not supported by this workspace",
          )
          return
        }
        const sessionId = `session-fork-${createHash("sha256")
          .update(params.requestId)
          .digest("hex")
          .slice(0, 20)}`
        const workspace = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.createSessionWorkspaceFromCheckpoint!(
            source.workspacePath!,
            checkpoint.commit!,
            sessionId,
            signal,
          ),
          this.#agentTimeoutMs,
          "Fork workspace creation timed out",
        )
        const agent = this.#agents.require(runtime.provider)
        let providerThreadId: string
        try {
          providerThreadId = await withLateCleanup(
            agent.startThread({ cwd: workspace.path, runtime }),
            this.#agentTimeoutMs,
            "Fork agent setup timed out",
            (threadId) => agent.stopThread(threadId),
            "Domovoi could not stop a late fork thread",
            (context, error) => this.#reportError(context, error),
          )
          if (signal?.aborted) {
            await withTimeout(
              agent.stopThread(providerThreadId),
              this.#agentTimeoutMs,
              "Cancelled fork thread cleanup timed out",
            )
            signal.throwIfAborted()
          }
        } catch (error) {
          try {
            await this.#withAbortTimeout(
              (signal) => this.#workspaceService.removeSessionWorkspace(workspace.path, signal),
              this.#agentTimeoutMs,
              "Fork workspace cleanup timed out",
            )
          } catch (cleanupError) {
            this.#reportError("Domovoi could not remove a failed fork worktree", cleanupError)
          }
          throw error
        }
        const createdAt = new Date().toISOString()
        const candidate = structuredClone(this.#snapshot)
        candidate.sessions.push({
          id: sessionId,
          projectId: source.projectId,
          title: `${source.title} · fork`,
          state: "idle",
          runtime,
          changedFiles: 0,
          testsPassed: source.testsPassed,
          testsFailed: source.testsFailed,
          updatedAt: createdAt,
          workspacePath: workspace.path,
          providerThreadId,
          baseCommit: checkpoint.commit,
          forkedFrom: {
            sourceSessionId: source.id,
            checkpointId: checkpoint.id,
            checkpointCommit: checkpoint.commit,
            requestId: params.requestId,
            client: params.client,
            requestedRuntime: params.runtime,
          },
        })
        candidate.thread.push({
          id: `checkpoint-${randomUUID()}`,
          sessionId,
          kind: "checkpoint",
          label: `${checkpoint.commit.slice(0, 8)} · forked checkpoint`,
          commit: checkpoint.commit,
          createdAt,
        })
        candidate.thread.push({
          id: `system-${randomUUID()}`,
          sessionId,
          kind: "system",
          body: `Forked from ${source.title}.`,
          detail: `Checkpoint ${checkpoint.commit.slice(0, 8)} started ${runtime.provider} / ${runtime.model} for ${params.client}. The source session, provider thread, worktree, and active selection were preserved.`,
          createdAt,
        })
        try {
          if (this.#store.saveAsync) await this.#store.saveAsync(candidate)
          else this.#store.save(candidate)
        } catch (error) {
          try {
            await withTimeout(
              agent.stopThread(providerThreadId),
              this.#agentTimeoutMs,
              "Failed fork provider cleanup timed out",
            )
          } catch (cleanupError) {
            this.#reportError("Domovoi could not stop a failed fork thread", cleanupError)
          }
          try {
            await this.#withAbortTimeout(
              (signal) => this.#workspaceService.removeSessionWorkspace(workspace.path, signal),
              this.#agentTimeoutMs,
              "Fork workspace cleanup timed out",
            )
          } catch (cleanupError) {
            this.#reportError("Domovoi could not remove a failed fork worktree", cleanupError)
          }
          throw error
        }
        this.#snapshot = candidate
        this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, providerThreadId))
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: workspaceSnapshotForClient(this.#snapshot),
        })
        this.#broadcastSnapshot()
        return
      }

      if (method === "session.send") {
        const params = paramsResult.data as RpcParams<"session.send">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (session?.state === "archiving" || session?.state === "archived") {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (!session?.workspacePath || !session.providerThreadId) {
          this.#error(socket, request.id, invalidParams, "Session is not ready for agent turns")
          return
        }
        const registeredAgent = this.#agents.require(session.runtime.provider)
        const violation = permissionViolation(session.runtime, registeredAgent)
        if (violation) {
          this.#error(socket, request.id, invalidParams, violation)
          return
        }
        const preparedTurn = await prepareAnnotationTurn(
          this.#snapshot,
          session.id,
          agentPromptWithHandoff(this.#snapshot, session.id, params.prompt),
          registeredAgent.capabilities,
          this.#annotationVisualContext,
        )
        const prompt = await agentPromptWithSkills(
          this.#skillCatalog ?? new FileSkillCatalog(
            skillRoots(homedir(), this.#snapshot.project?.path),
          ),
          this.#snapshot,
          preparedTurn.prompt,
          {
            requireTrusted: session.runtime.permissionMode === "build" && session.runtime.auto,
          },
        )
        const createdAt = new Date().toISOString()
        const emergencyThread = providerThreadKey(
          session.runtime.provider,
          session.providerThreadId,
        )
        const providerThreadId = session.providerThreadId
        if (this.#failedEmergencyThreads.has(emergencyThread)) {
          this.#error(socket, request.id, invalidParams, "Provider thread requires recovery after emergency stop")
          return
        }
        this.#emergencyBlockedThreads.delete(emergencyThread)
        this.#inFlightProviderThreads.set(emergencyThread, session.id)
        let agent: AgentAdapter
        try {
          agent = await this.#ensureAgentConnected(session.runtime.provider)
        } catch (error) {
          this.#inFlightProviderThreads.delete(emergencyThread)
          throw error
        }
        if (signal?.aborted) {
          this.#inFlightProviderThreads.delete(emergencyThread)
          signal.throwIfAborted()
        }
        const loadedThread = providerThreadKey(session.runtime.provider, providerThreadId)
        if (!this.#loadedAgentThreads.has(loadedThread)) {
          try {
            await withTimeout(
              agent.resumeThread({
                threadId: providerThreadId,
                cwd: session.workspacePath,
                runtime: session.runtime,
              }),
              this.#agentTimeoutMs,
              "Agent thread resume timed out",
            )
          } catch (error) {
            this.#inFlightProviderThreads.delete(emergencyThread)
            if (error instanceof OperationTimeoutError) {
              await this.#quarantineProviderThread(session.id, error.message)
            }
            throw error
          }
          if (signal?.aborted) {
            this.#inFlightProviderThreads.delete(emergencyThread)
            signal.throwIfAborted()
          }
          this.#loadedAgentThreads.add(loadedThread)
        }
        let turnId = session.activeTurnId
        try {
          signal?.throwIfAborted()
          if (turnId) {
            await withTimeout(
              preparedTurn.visualContexts.length > 0
                ? agent.steerTurn(providerThreadId, turnId, prompt, preparedTurn.visualContexts)
                : agent.steerTurn(providerThreadId, turnId, prompt),
              this.#agentTimeoutMs,
              "Agent steering timed out",
            )
          } else {
            turnId = await withTimeout(
              agent.startTurn({
                threadId: providerThreadId,
                cwd: session.workspacePath,
                prompt,
                runtime: session.runtime,
                ...(preparedTurn.visualContexts.length > 0
                  ? { visualContexts: preparedTurn.visualContexts }
                  : {}),
              }),
              this.#agentTimeoutMs,
              "Agent turn timed out",
            )
          }
        } catch (error) {
          this.#inFlightProviderThreads.delete(emergencyThread)
          if (error instanceof OperationTimeoutError) {
            await this.#quarantineProviderThread(session.id, error.message)
          }
          throw error
        }
        if (signal?.aborted) {
          if (turnId) await this.#stopCancelledProviderTurn(session, turnId, providerThreadId)
          this.#inFlightProviderThreads.delete(emergencyThread)
          signal.throwIfAborted()
        }
        this.#inFlightProviderThreads.delete(emergencyThread)
        signal?.throwIfAborted()
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        this.#snapshot.thread.push({
          id: `user-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "user",
          body: params.prompt,
          createdAt,
        })
        currentSession.state = "active"
        currentSession.updatedAt = createdAt
        currentSession.activeTurnId = turnId
        delete currentSession.providerFailure
        this.#snapshot.activeSessionId = currentSession.id
        changed = true
      }

      if (method === "checkpoint.create") {
        const params = paramsResult.data as RpcParams<"checkpoint.create">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (session?.state === "archiving" || session?.state === "archived") {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (!session?.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        if (session.activeTurnId) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Stop the active turn before creating a checkpoint",
          )
          return
        }
        const label = params.label ?? "manual"
        const checkpoint = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.checkpoint(session.workspacePath!, label, signal),
          this.#agentTimeoutMs,
          "Checkpoint timed out",
        )
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        currentSession.changedFiles = checkpoint.changedFiles.length
        currentSession.updatedAt = new Date().toISOString()
        this.#snapshot.thread.push({
          id: `checkpoint-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "checkpoint",
          label: `${checkpoint.commit.slice(0, 8)} · ${label}`,
          commit: checkpoint.commit,
          createdAt: currentSession.updatedAt,
        })
        changed = true
      }

      if (method === "checkpoint.restore") {
        const params = paramsResult.data as RpcParams<"checkpoint.restore">
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (session?.state === "archiving" || session?.state === "archived") {
          this.#error(socket, request.id, invalidParams, "Archived sessions are read-only")
          return
        }
        if (!session?.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        if (session.activeTurnId) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Stop the active turn before restoring a checkpoint",
          )
          return
        }
        const item = this.#snapshot.thread.find(
          (candidate) => candidate.id === params.checkpointId
            && candidate.sessionId === session.id
            && candidate.kind === "checkpoint",
        )
        if (!item || item.kind !== "checkpoint" || !item.commit) {
          this.#error(socket, request.id, invalidParams, "Checkpoint cannot be restored")
          return
        }
        const restored = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.restore(
            session.workspacePath!,
            item.commit!,
            signal,
          ),
          this.#agentTimeoutMs,
          "Checkpoint restore timed out",
        )
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        const createdAt = new Date().toISOString()
        currentSession.updatedAt = createdAt
        this.#snapshot.thread.push({
          id: `checkpoint-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "checkpoint",
          label: `${restored.recoveryCommit.slice(0, 8)} · before restore`,
          commit: restored.recoveryCommit,
          createdAt,
        })
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "system",
          body: "Worktree restored",
          detail: `Restored ${restored.restoredCommit.slice(0, 8)} from ${params.client}. Recovery checkpoint ${restored.recoveryCommit.slice(0, 8)} preserved the previous state.`,
          createdAt,
        })
        changed = true
      }

      const clientSnapshot = changed
        ? structuredClone(workspaceSnapshotForClient(this.#snapshot))
        : workspaceSnapshotForClient(this.#snapshot)
      if (changed) this.#syncArtifactWatchers()
      workspaceSnapshotSchema.parse(this.#snapshot)
      if (changed && !alreadyPersisted) await this.#persistSnapshot()
      const helloConnectionId = this.#connectionIds.get(socket)
      const result = method === "system.hello"
        ? {
            ...clientSnapshot,
            ...(helloConnectionId ? { connectionId: helloConnectionId } : {}),
          }
        : clientSnapshot
      this.#send(socket, {
        jsonrpc: "2.0",
        id: request.id,
        result: rpcMethods[method].result.parse(result),
      })

      if (changed) this.#broadcastNotification("workspace.changed", clientSnapshot)
    } catch (error) {
      if (signal?.aborted) {
        this.#error(socket, request.id, internalError, "Operation cancelled by emergency stop")
        return
      }
      if (error instanceof PublicRpcError) {
        if (error instanceof OperationTimeoutError) {
          this.#reportError(`RPC ${method} timed out`, error)
        }
        this.#error(socket, request.id, error.code, error.message)
        return
      }
      this.#reportError(`RPC ${method} failed`, error)
      this.#error(socket, request.id, internalError, internalRpcErrorMessage)
    }
  }

  async #handleAgentEvent(provider: string, event: AgentEvent): Promise<void> {
    if (event.type === "provider-disconnected") {
      this.#appendAudit({
        actor: { kind: "provider", provider },
        action: "provider.disconnected",
        outcome: "failed",
        ...(this.#snapshot.project ? { projectId: this.#snapshot.project.id } : {}),
      })
      await this.#handleProviderDisconnect(provider, event.reason)
      return
    }
    const threadId = threadIdForAgentEvent(event)
    if (!threadId) return
    if (this.#emergencyBlockedThreads.has(providerThreadKey(provider, threadId))) return
    const session = this.#snapshot.sessions.find(
      (candidate) => candidate.runtime.provider === provider && candidate.providerThreadId === threadId,
    )
    if (!session) return
    if (session.state === "archiving" || session.state === "archived") return
    const eventTurnId = turnIdForAgentEvent(event)
    if (eventTurnId && eventTurnId !== session.activeTurnId) return
    if (event.type === "usage") {
      try {
        this.#usageLedger.record({
          sessionId: session.id,
          turnId: event.turnId,
          provider,
          model: session.runtime.model,
          usage: event.usage,
        })
      } catch (error) {
        this.#reportError("Domovoi could not persist provider usage", error)
      }
      return
    }
    const createdAt = new Date().toISOString()
    const delta: WorkspaceDelta = {
      sessionId: session.id,
      updatedAt: createdAt,
      operations: [],
    }
    let requiresFullSnapshot = false

    if (event.type === "text-delta") {
      const itemId = `assistant-message-${event.turnId ?? session.id}`
      const existing = this.#snapshot.thread.find(
        (item) => item.id === itemId && item.kind === "assistant",
      )
      if (existing?.kind === "assistant") existing.body += event.delta
      else {
        this.#snapshot.thread.push({
          id: itemId,
          sessionId: session.id,
          kind: "assistant",
          body: event.delta,
          createdAt,
        })
      }
      delta.operations.push(...workspaceDeltaChunks(event.delta).map((chunk) => ({
        kind: "assistant.append" as const,
        id: itemId,
        delta: chunk,
        createdAt,
      })))
    }

    if (event.type === "plan-delta") {
      const previousPlanIds = new Set(this.#snapshot.artifacts.filter((artifact) =>
        artifact.sessionId === session.id && artifact.type === "plan"
      ).map((artifact) => artifact.id))
      const artifact = appendPlanDelta(
        this.#snapshot.artifacts,
        this.#snapshot.annotations,
        session.id,
        event.delta,
      )
      requiresFullSnapshot = [...previousPlanIds].some((id) => id !== artifact.id)
      if (!requiresFullSnapshot) {
        delta.operations.push(...workspaceDeltaChunks(event.delta).map((chunk) => ({
          kind: "plan.append" as const,
          id: artifact.id,
          delta: chunk,
          revision: artifact.revision,
        })))
      }
    }

    if (event.type === "command-output") {
      const itemId = `tool-${event.itemId ?? event.turnId ?? randomUUID()}`
      const streamKey = `${session.id}\u0000${itemId}`
      const stream = this.#commandOutputRedactors.get(streamKey) ?? {
        itemId,
        redactor: new DurableOutputRedactor(),
      }
      this.#commandOutputRedactors.set(streamKey, stream)
      const safeDelta = stream.redactor.push(event.delta)
      const existing = this.#snapshot.thread.find((item) => item.id === itemId)
      if (existing?.kind === "tool") {
        if (safeDelta) existing.output = appendDurableOutput(existing.output, safeDelta)
      } else {
        this.#snapshot.thread.push({
          id: itemId,
          sessionId: session.id,
          kind: "tool",
          tool: "command",
          status: "running",
          title: "Command output",
          ...(safeDelta ? { output: safeDelta } : {}),
          createdAt,
        })
      }
      if (safeDelta) {
        delta.operations.push(...workspaceDeltaChunks(safeDelta).map((chunk) => ({
          kind: "tool-output.append" as const,
          id: itemId,
          delta: chunk,
          createdAt,
        })))
      }
    }

    if (event.type === "diff-updated") {
      const artifactId = `diff-${session.id}`
      const existing = this.#snapshot.artifacts.find((artifact) => artifact.id === artifactId)
      if (existing) {
        existing.content = event.diff
        existing.revision += 1
      } else {
        this.#snapshot.artifacts.push({
          id: artifactId,
          sessionId: session.id,
          title: "Working changes",
          type: "diff",
          revision: 1,
          mimeType: "text/x-diff",
          content: event.diff,
        })
      }
    }

    if (event.type === "approval-requested") {
      const project = this.#snapshot.project
      if (!project) return
      const decision = permissionDecisionFor({
        runtime: session.runtime,
        ...(event.command ? { command: event.command } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      })
      const commandCopy = redactDurableCommand(event.command ?? "Command details unavailable")
      const reasonCopy = redactDurableText(event.reason ?? "Run a command")
      const directoryCopy = redactDurableText(event.cwd ?? session.workspacePath ?? project.path)
      const containsSecret = commandCopy.redacted || reasonCopy.redacted || directoryCopy.redacted
      const matchingRule = this.#snapshot.approvalRules.find(
        (rule) => !containsSecret
          && rule.projectId === project.id
          && rule.command === event.command,
      )
      this.#appendAudit({
        actor: { kind: "provider", provider, providerThreadId: threadId },
        action: "provider.approval-requested",
        outcome: !containsSecret
          && (decision.action === "allow" || (decision.risk === "normal" && matchingRule))
          ? "succeeded"
          : "started",
        sessionId: session.id,
        projectId: project.id,
        ...(event.itemId ? { target: event.itemId } : {}),
      })
      if (!containsSecret && decision.action === "allow") {
        this.#agents.require(provider).resolveApproval(event.requestId, "allow-once")
      } else if (decision.risk === "normal" && matchingRule) {
        this.#agents.require(provider).resolveApproval(event.requestId, "always-project")
      } else {
        this.#snapshot.approvals.push({
          id: `approval-${randomUUID()}`,
          sessionId: session.id,
          risk: containsSecret ? "hard-gate" : decision.risk,
          operation: reasonCopy.value,
          command: commandCopy.value,
          machine: this.#snapshot.machine.name,
          agent: `${session.runtime.provider} / ${session.runtime.model}`,
          mode: session.runtime.permissionMode,
          directory: directoryCopy.value,
          affects: "Files and processes in the session worktree.",
          network: "No agent network access granted.",
          estimatedDuration: "Unknown",
          checkpoint: session.baseCommit ?? "unavailable",
          providerRequestId: event.requestId,
          requestedAt: createdAt,
        })
        session.state = "waiting"
      }
    }

    if (event.type === "item") {
      const item = event.params.item
      const itemRecord = item && typeof item === "object" ? item as Record<string, unknown> : undefined
      const itemStatus = itemRecord?.status
      const itemOutcome: AuditOutcome = event.phase === "started"
        ? "started"
        : itemStatus === "failed"
          ? "failed"
          : itemStatus === "declined"
            ? "denied"
            : "succeeded"
      this.#appendAudit({
        actor: { kind: "provider", provider, providerThreadId: threadId },
        action: `provider.tool.${event.phase}`,
        outcome: itemOutcome,
        sessionId: session.id,
        ...(this.#snapshot.project ? { projectId: this.#snapshot.project.id } : {}),
        ...(typeof itemRecord?.id === "string" ? { target: itemRecord.id } : {}),
      })
      if (item && typeof item === "object" && "type" in item && item.type === "commandExecution") {
        const commandItem = item as Record<string, unknown>
        const id = `tool-${String(commandItem.id ?? randomUUID())}`
        const streamKey = `${session.id}\u0000${id}`
        const streamedRemainder = this.#commandOutputRedactors.get(streamKey)?.redactor.flush() ?? ""
        this.#commandOutputRedactors.delete(streamKey)
        const command = Array.isArray(commandItem.command)
          ? commandItem.command.join(" ")
          : String(commandItem.command ?? "Command")
        const commandCopy = redactDurableCommand(command).value
        const outputCopy = typeof commandItem.aggregatedOutput === "string"
          ? redactDurableOutput(commandItem.aggregatedOutput).value
          : undefined
        const status = commandItem.status === "failed"
          ? "failed"
          : commandItem.status === "declined"
            ? "declined"
            : event.phase === "completed"
              ? "completed"
              : "running"
        const existing = this.#snapshot.thread.find((threadItem) => threadItem.id === id)
        if (existing?.kind === "tool") {
          existing.status = status
          existing.title = commandCopy
          if (outputCopy !== undefined) existing.output = outputCopy
          else if (streamedRemainder) {
            existing.output = appendDurableOutput(existing.output, streamedRemainder)
          }
        } else {
          this.#snapshot.thread.push({
            id,
            sessionId: session.id,
            kind: "tool",
            tool: "command",
            status,
            title: commandCopy,
            ...(outputCopy !== undefined || streamedRemainder
              ? { output: outputCopy ?? streamedRemainder }
              : {}),
            createdAt,
          })
        }
      }
      if (item && typeof item === "object" && "type" in item && item.type === "fileChange") {
        const fileChange = item as Record<string, unknown>
        const changes = Array.isArray(fileChange.changes) ? fileChange.changes : []
        for (const change of changes) {
          if (!change || typeof change !== "object" || !("path" in change)) continue
          const path = String(change.path)
          if (!path.toLowerCase().endsWith(".html") || !session.workspacePath) continue
          const lexicalPath = resolveInside(session.workspacePath, path)
          if (!lexicalPath || !await resolveInsideReal(session.workspacePath, lexicalPath)) continue
          const relativePath = relative(resolve(session.workspacePath), lexicalPath).replaceAll("\\", "/")
          const artifactId = `preview-${createHash("sha256")
            .update(`${session.id}:${lexicalPath}`)
            .digest("hex")
            .slice(0, 16)}`
          const existing = this.#snapshot.artifacts.find(
            (artifact) => artifact.id === artifactId,
          )
          if (existing) {
            existing.path = relativePath
            existing.revision += 1
          }
          else this.#snapshot.artifacts.push({
            id: artifactId,
            sessionId: session.id,
            title: basename(lexicalPath),
            type: "preview",
            revision: 1,
            path: relativePath,
            mimeType: "text/html",
          })
        }
      }
    }

    if (event.type === "turn-completed") {
      const { failed, failure } = providerTurnCompletion(event.params)
      session.state = failed ? "failed" : "idle"
      if (failure) session.providerFailure = failure
      else delete session.providerFailure
      delete session.activeTurnId
      this.#flushCommandOutputStreams(session.id)
      this.#appendAudit({
        actor: { kind: "provider", provider, providerThreadId: threadId },
        action: "provider.turn-completed",
        outcome: failed ? "failed" : "succeeded",
        sessionId: session.id,
        ...(this.#snapshot.project ? { projectId: this.#snapshot.project.id } : {}),
      })
    }

    session.updatedAt = createdAt
    this.#sessionHistory.invalidate(session.id)
    if (
      event.type === "text-delta" ||
      event.type === "plan-delta" ||
      event.type === "command-output"
    ) {
      if (requiresFullSnapshot) this.#broadcastSnapshot()
      else {
        for (let offset = 0; offset < delta.operations.length; offset += maximumWorkspaceDeltaOperations) {
          this.#broadcastNotification("workspace.delta", workspaceDeltaSchema.parse({
            ...delta,
            operations: delta.operations.slice(offset, offset + maximumWorkspaceDeltaOperations),
          }))
        }
      }
      this.#scheduleDeltaFlush()
    } else {
      await this.#flushAgentState()
    }
  }

  async #handleProviderDisconnect(provider: string, reason: string): Promise<void> {
    const hadConnection = this.#connectedAgents.delete(provider)
      || this.#agentConnections.has(provider)
      || this.#providerModels.has(provider)
      || this.#providerModelRequests.has(provider)
      || [...this.#loadedAgentThreads].some((key) => key.startsWith(`${provider}\u0000`))
    this.#agentConnections.delete(provider)
    this.#providerModels.delete(provider)
    this.#providerModelRequests.delete(provider)
    this.#providerEpochs.set(provider, this.#providerEpoch(provider) + 1)
    for (const key of [...this.#loadedAgentThreads]) {
      if (key.startsWith(`${provider}\u0000`)) this.#loadedAgentThreads.delete(key)
    }
    if (!hadConnection) return

    const createdAt = new Date().toISOString()
    const providerName = provider === "codex" ? "Codex" : provider
    let changed = false
    const affectedSessionIds = new Set<string>()
    for (const session of this.#snapshot.sessions) {
      if (session.runtime.provider !== provider || !session.providerThreadId) continue
      affectedSessionIds.add(session.id)
      session.state = "failed"
      session.providerFailure = classifyProviderFailure(new Error(reason))
      this.#flushCommandOutputStreams(session.id)
      delete session.activeTurnId
      session.updatedAt = createdAt
      this.#snapshot.thread.push({
        id: `system-${randomUUID()}`,
        sessionId: session.id,
        kind: "system",
        body: `${providerName} disconnected. The next message will reconnect and resume this session.`,
        detail: redactDurableText(reason).value,
        createdAt,
      })
      changed = true
    }
    if (affectedSessionIds.size > 0) {
      this.#snapshot.approvals = this.#snapshot.approvals.filter(
        (approval) => !affectedSessionIds.has(approval.sessionId),
      )
    }
    if (changed) await this.#flushAgentState()
  }

  #providerEpoch(provider: string): number {
    return this.#providerEpochs.get(provider) ?? 0
  }

  #flushCommandOutputStreams(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const [key, stream] of this.#commandOutputRedactors) {
      if (!key.startsWith(prefix)) continue
      const remainder = stream.redactor.flush()
      this.#commandOutputRedactors.delete(key)
      if (!remainder) continue
      const item = this.#snapshot.thread.find((candidate) => candidate.id === stream.itemId)
      if (item?.kind === "tool") item.output = appendDurableOutput(item.output, remainder)
    }
  }

  #enqueueEmergencyStop(client: ClientKind): Promise<SystemEmergencyStopResult> {
    const run = this.#emergencyStopTail.then(
      () => this.#performEmergencyStop(client),
      () => this.#performEmergencyStop(client),
    )
    this.#emergencyStopTail = run.then(() => undefined, () => undefined)
    return run
  }

  async #performEmergencyStop(client: ClientKind): Promise<SystemEmergencyStopResult> {
    const requestedAt = new Date().toISOString()
    const stopId = `stop-${randomUUID()}`
    const failures: SystemEmergencyStopResult["failures"] = []
    const affectedSessionIds = new Set<string>()
    const active = this.#snapshot.sessions.filter(
      (session) => !sessionIsArchiveReadOnly(session)
        && session.providerThreadId
        && session.activeTurnId,
    )
    for (const session of active) {
      affectedSessionIds.add(session.id)
      this.#emergencyBlockedThreads.add(
        providerThreadKey(session.runtime.provider, session.providerThreadId!),
      )
      this.#flushCommandOutputStreams(session.id)
    }
    for (const [threadKey, sessionId] of this.#inFlightProviderThreads) {
      this.#emergencyBlockedThreads.add(threadKey)
      affectedSessionIds.add(sessionId)
    }
    for (const approval of this.#snapshot.approvals) affectedSessionIds.add(approval.sessionId)
    for (const terminal of this.#terminals.values()) affectedSessionIds.add(terminal.sessionId)

    const cancellation = new Error("Emergency stop requested")
    const cancelledMutations = this.#mutations.cancelAll(cancellation)
    const mutationsCancelled = cancelledMutations.active + cancelledMutations.queued
    this.#workspaceAbort.abort(cancellation)
    this.#workspaceAbort = new AbortController()

    let terminalsClosed = 0
    for (const terminalId of [...this.#terminals.keys()]) {
      try {
        if (this.#closeTerminal(terminalId)) terminalsClosed += 1
      } catch (error) {
        failures.push({
          target: "terminal",
          targetId: terminalId,
          message: this.#emergencyFailureMessage(error, "Terminal close failed"),
        })
      }
    }

    let approvalsDenied = 0
    for (const approval of this.#snapshot.approvals) {
      try {
        if (approval.providerRequestId !== undefined) {
          this.#agents.require(
            this.#snapshot.sessions.find(({ id }) => id === approval.sessionId)!.runtime.provider,
          ).resolveApproval(approval.providerRequestId, "deny")
        }
        approvalsDenied += 1
        this.#snapshot.thread.push({
          id: `receipt-${approval.id}-${randomUUID()}`,
          sessionId: approval.sessionId,
          kind: "receipt",
          operation: approval.operation,
          decision: "deny",
          checkpoint: approval.checkpoint,
          client,
          explanation: "Emergency stop",
          createdAt: requestedAt,
        })
      } catch (error) {
        failures.push({
          target: "approval",
          targetId: approval.id,
          message: this.#emergencyFailureMessage(error, "Approval denial failed"),
        })
      }
    }
    this.#snapshot.approvals = []

    let turnsStopped = 0
    let providersReset = 0
    const activeThreadKeys = new Set(active.map((session) =>
      providerThreadKey(session.runtime.provider, session.providerThreadId!),
    ))
    const turnResults = await Promise.allSettled(active.map((session) =>
      withTimeout(
        this.#agents.require(session.runtime.provider).interruptTurn(
          session.providerThreadId!,
          session.activeTurnId!,
        ),
        this.#agentTimeoutMs,
        "Emergency agent interrupt timed out",
      ),
    ))
    for (const [index, result] of turnResults.entries()) {
      const original = active[index]!
      const session = this.#snapshot.sessions.find(({ id }) => id === original.id)
      if (!session) continue
      const activeTurnId = session.activeTurnId
      session.updatedAt = requestedAt
      delete session.activeTurnId
      if (result.status === "fulfilled") {
        turnsStopped += 1
        session.state = "idle"
        continue
      }
      let fallbackStopped = false
      try {
        await withTimeout(
          this.#agents.require(session.runtime.provider).stopThread(session.providerThreadId!),
          this.#agentTimeoutMs,
          "Emergency provider reset timed out",
        )
        fallbackStopped = true
        turnsStopped += 1
        providersReset += 1
      } catch (fallbackError) {
        failures.push({
          target: "turn",
          ...(activeTurnId ? { targetId: activeTurnId } : {}),
          message: this.#emergencyFailureMessage(fallbackError, "Provider reset failed"),
        })
      }
      session.state = "failed"
      if (fallbackStopped) {
        this.#loadedAgentThreads.delete(
          providerThreadKey(session.runtime.provider, session.providerThreadId!),
        )
        delete session.providerThreadId
      } else {
        this.#failedEmergencyThreads.add(
          providerThreadKey(session.runtime.provider, session.providerThreadId!),
        )
      }
    }

    const inFlight = [...this.#inFlightProviderThreads.entries()]
      .filter(([threadKey]) => !activeThreadKeys.has(threadKey))
    const inFlightResults = await Promise.allSettled(inFlight.map(([threadKey, sessionId]) => {
      const session = this.#snapshot.sessions.find(({ id }) => id === sessionId)
      if (!session?.providerThreadId) return Promise.resolve()
      const expectedKey = providerThreadKey(session.runtime.provider, session.providerThreadId)
      if (expectedKey !== threadKey) return Promise.resolve()
      return withTimeout(
        this.#agents.require(session.runtime.provider).stopThread(session.providerThreadId),
        this.#agentTimeoutMs,
        "Emergency in-flight provider reset timed out",
      )
    }))
    for (const [index, result] of inFlightResults.entries()) {
      const [threadKey, sessionId] = inFlight[index]!
      const session = this.#snapshot.sessions.find(({ id }) => id === sessionId)
      if (!session) continue
      session.updatedAt = requestedAt
      session.state = "failed"
      if (result.status === "fulfilled") {
        providersReset += 1
        this.#loadedAgentThreads.delete(threadKey)
        if (
          session.providerThreadId
          && providerThreadKey(session.runtime.provider, session.providerThreadId) === threadKey
        ) delete session.providerThreadId
      } else {
        this.#failedEmergencyThreads.add(threadKey)
        failures.push({
          target: "provider",
          targetId: threadKey.split("\u0000", 2)[1],
          message: this.#emergencyFailureMessage(result.reason, "Provider reset failed"),
        })
      }
    }

    for (const sessionId of affectedSessionIds) {
      const session = this.#snapshot.sessions.find(({ id }) => id === sessionId)
      if (!session || sessionIsArchiveReadOnly(session)) continue
      this.#snapshot.thread.push({
        id: `system-${randomUUID()}`,
        sessionId,
        kind: "system",
        body: `Emergency stop requested by ${client}.`,
        detail: `${stopId}: ${turnsStopped} turns stopped, ${providersReset} providers reset, ${terminalsClosed} terminals closed, ${approvalsDenied} approvals denied, ${mutationsCancelled} mutations cancelled, and ${failures.length} failures recorded.`,
        createdAt: requestedAt,
      })
    }

    try {
      await this.#saveAgentState(false)
    } catch (error) {
      failures.push({
        target: "persistence",
        message: this.#emergencyFailureMessage(error, "Emergency state persistence failed"),
      })
      this.#reportError("Domovoi could not persist emergency stop state", error)
    }
    const result: SystemEmergencyStopResult = {
      snapshot: workspaceSnapshotForClient(this.#snapshot),
      stopId,
      requestedAt,
      client,
      outcomes: {
        turnsStopped,
        terminalsClosed,
        approvalsDenied,
        mutationsCancelled,
        providersReset,
      },
      failures: failures.slice(0, 100),
    }
    this.#broadcastSnapshot()
    this.#broadcastNotification("system.emergencyStopped", result)
    return result
  }

  #withAbortTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return withAbortTimeout(operation, timeoutMs, message, this.#workspaceAbort.signal)
  }

  #emergencyFailureMessage(error: unknown, fallback: string): string {
    const errorMessage = error instanceof Error ? error.message : ""
    const detail = redactDurableText(errorMessage.trim() ? errorMessage : fallback).value
    const nonemptyDetail = detail.trim() ? detail : redactDurableText(fallback).value
    return nonemptyDetail.slice(0, maximumEmergencyStopFailureMessageLength)
  }

  async #stopCancelledProviderTurn(
    session: WorkspaceSnapshot["sessions"][number],
    turnId: string,
    providerThreadId = session.providerThreadId,
  ): Promise<void> {
    const threadId = providerThreadId
    if (!threadId) return
    const key = providerThreadKey(session.runtime.provider, threadId)
    this.#emergencyBlockedThreads.add(key)
    try {
      await withTimeout(
        this.#agents.require(session.runtime.provider).interruptTurn(threadId, turnId),
        this.#agentTimeoutMs,
        "Cancelled provider turn interrupt timed out",
      )
    } catch {
      try {
        await withTimeout(
          this.#agents.require(session.runtime.provider).stopThread(threadId),
          this.#agentTimeoutMs,
          "Cancelled provider reset timed out",
        )
        this.#loadedAgentThreads.delete(key)
        delete session.providerThreadId
      } catch {
        this.#failedEmergencyThreads.add(key)
      }
    }
  }

  async #pauseSessions(
    active: WorkspaceSnapshot["sessions"],
    client: ClientKind,
  ): Promise<boolean> {
    const results = await Promise.allSettled(active.map(async (session) =>
      withTimeout(
        this.#agents.require(session.runtime.provider)
          .interruptTurn(session.providerThreadId!, session.activeTurnId!),
        this.#agentTimeoutMs,
        "Agent interrupt timed out",
      ),
    ))
    const createdAt = new Date().toISOString()
    const quarantined: Array<{ sessionId: string; reason: string }> = []
    for (const [index, result] of results.entries()) {
      const sessionId = active[index]!.id
      const session = this.#snapshot.sessions.find((candidate) => candidate.id === sessionId)
      if (!session) continue
      session.updatedAt = createdAt
      if (result.status === "fulfilled") {
        session.state = "idle"
        delete session.activeTurnId
        this.#snapshot.approvals = this.#snapshot.approvals.filter(
          (approval) => approval.sessionId !== session.id,
        )
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId: session.id,
          kind: "system",
          body: `Paused by ${client}.`,
          createdAt,
        })
      } else if (result.reason instanceof OperationTimeoutError) {
        quarantined.push({ sessionId: session.id, reason: result.reason.message })
      } else {
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId: session.id,
          kind: "system",
          body: `Pause failed for ${client}.`,
          detail: redactDurableText(
            result.reason instanceof Error ? result.reason.message : "Unknown provider error",
          ).value,
          createdAt,
        })
      }
    }
    await Promise.all(quarantined.map(({ sessionId, reason }) =>
      this.#quarantineProviderThread(sessionId, reason),
    ))
    return active.length > 0
  }

  async #recoverSessionArchives(): Promise<void> {
    for (const session of this.#snapshot.sessions.filter(
      (candidate) => candidate.state === "archiving",
    )) {
      await this.#mutations.enqueue(
        `session:${session.id}`,
        async () => {
          try {
            await this.#archiveSession(session.id)
          } catch (error) {
            this.#reportError(`Domovoi could not resume archive cleanup for ${session.id}`, error)
          }
        },
      )
    }
  }

  #recoverInterruptedTurns(): void {
    const interrupted = this.#snapshot.sessions.filter(
      (session) => session.state !== "archiving"
        && session.state !== "archived"
        && session.activeTurnId,
    )
    if (interrupted.length === 0) return

    const recoveredAt = new Date().toISOString()
    const candidate = structuredClone(this.#snapshot)
    const recoveredTurns: Array<{ sessionId: string; turnId: string }> = []
    const expiredApprovals = candidate.approvals.filter(
      (approval) => interrupted.some((session) => session.id === approval.sessionId),
    )
    const interruptedSessionIds = new Set(interrupted.map((session) => session.id))

    for (const session of candidate.sessions) {
      if (!interruptedSessionIds.has(session.id) || !session.activeTurnId) continue
      recoveredTurns.push({ sessionId: session.id, turnId: session.activeTurnId })
      session.state = "idle"
      session.updatedAt = recoveredAt
      delete session.activeTurnId
      candidate.thread.push({
        id: `system-${randomUUID()}`,
        sessionId: session.id,
        kind: "system",
        body: "Daemon restart interrupted the active turn.",
        detail: `${expiredApprovals.some((approval) => approval.sessionId === session.id)
          ? "Pending approval requests were expired. "
          : ""}The worktree and session history were preserved. Send another message to continue with a new provider turn.`,
        createdAt: recoveredAt,
      })
    }

    candidate.approvals = candidate.approvals.filter(
      (approval) => !interruptedSessionIds.has(approval.sessionId),
    )

    workspaceSnapshotSchema.parse(candidate)
    this.#store.save(candidate)
    this.#snapshot = candidate
    for (const recovered of recoveredTurns) {
      this.#appendAudit({
        actor: { kind: "daemon", component: "startup-recovery" },
        action: "session.turn-interrupted",
        outcome: "cancelled",
        sessionId: recovered.sessionId,
        ...(candidate.project ? { projectId: candidate.project.id } : {}),
        target: recovered.turnId,
      })
    }
    for (const approval of expiredApprovals) {
      this.#appendAudit({
        actor: { kind: "daemon", component: "startup-recovery" },
        action: "approval.expired",
        outcome: "cancelled",
        sessionId: approval.sessionId,
        ...(candidate.project ? { projectId: candidate.project.id } : {}),
        target: approval.id,
      })
    }
  }

  async #archiveSession(sessionId: string, client?: ClientKind): Promise<void> {
    const session = this.#snapshot.sessions.find((candidate) => candidate.id === sessionId)
    if (!session || session.state === "archived") return
    this.#flushCommandOutputStreams(sessionId)
    if (session.state !== "archiving") {
      const requestedAt = new Date().toISOString()
      session.state = "archiving"
      session.archiveRequestedAt = requestedAt
      session.updatedAt = requestedAt
      this.#snapshot.thread.push({
        id: `system-${randomUUID()}`,
        sessionId,
        kind: "system",
        body: `Session archive requested${client ? ` by ${client}` : ""}.`,
        detail: "Domovoi will preserve history and a final checkpoint, then stop active resources and remove only the isolated worktree.",
        createdAt: requestedAt,
      })
      await this.#saveAgentState()
    }

    this.#closeSessionTerminals(sessionId)

    const approvals = this.#snapshot.approvals.filter(
      (approval) => approval.sessionId === sessionId,
    )
    const unresolvedApprovalIds = new Set<string>()
    for (const approval of approvals) {
      try {
        if (approval.providerRequestId !== undefined) {
          await this.#agents.require(session.runtime.provider).resolveApproval(
            approval.providerRequestId,
            "deny",
          )
        }
      } catch (error) {
        unresolvedApprovalIds.add(approval.id)
        this.#reportError(`Domovoi could not deny archive approval ${approval.id}`, error)
        continue
      }
      this.#snapshot.thread.push({
        id: `receipt-${approval.id}-${Date.now()}`,
        sessionId,
        kind: "receipt",
        decision: "deny",
        operation: approval.operation,
        checkpoint: approval.checkpoint,
        client: client ?? "cli",
        explanation: "Session archived",
        createdAt: new Date().toISOString(),
      })
      this.#snapshot.approvals = this.#snapshot.approvals.filter(
        (candidate) => candidate.id !== approval.id,
      )
      await this.#saveAgentState(false)
    }

    if (session.activeTurnId && session.providerThreadId) {
      await this.#loadProviderThreadForArchive(session)
      try {
        await withTimeout(
          this.#agents.require(session.runtime.provider).interruptTurn(
            session.providerThreadId,
            session.activeTurnId,
          ),
          this.#agentTimeoutMs,
          "Archive turn interrupt timed out",
        )
        delete session.activeTurnId
        await this.#saveAgentState(false)
      } catch (error) {
        this.#reportError(
          `Domovoi could not interrupt active turn for archive ${session.id}; stopping provider`,
          error,
        )
      }
    }

    if (session.providerThreadId) {
      const threadId = session.providerThreadId
      await this.#loadProviderThreadForArchive(session)
      await withTimeout(
        this.#agents.require(session.runtime.provider).stopThread(threadId),
        this.#agentTimeoutMs,
        "Archive provider cleanup timed out",
      )
      this.#loadedAgentThreads.delete(providerThreadKey(session.runtime.provider, threadId))
      delete session.providerThreadId
      delete session.activeTurnId
      await this.#saveAgentState(false)
    }

    if (!session.providerThreadId && unresolvedApprovalIds.size > 0) {
      for (const approval of approvals.filter(({ id }) => unresolvedApprovalIds.has(id))) {
        this.#snapshot.thread.push({
          id: `receipt-${approval.id}-${Date.now()}`,
          sessionId,
          kind: "receipt",
          decision: "deny",
          operation: approval.operation,
          checkpoint: approval.checkpoint,
          client: client ?? "cli",
          explanation: "Session archived after provider cleanup",
          createdAt: new Date().toISOString(),
        })
      }
      this.#snapshot.approvals = this.#snapshot.approvals.filter(
        ({ id }) => !unresolvedApprovalIds.has(id),
      )
      await this.#saveAgentState(false)
    }

    if (!session.archiveCheckpoint) {
      if (session.workspacePath) {
        const checkpoint = await this.#withAbortTimeout(
          (signal) => this.#workspaceService.checkpoint(
            session.workspacePath!,
            "before session archive",
            signal,
          ),
          this.#agentTimeoutMs,
          "Archive checkpoint timed out",
        )
        session.archiveCheckpoint = checkpoint.commit
        session.changedFiles = checkpoint.changedFiles.length
        session.updatedAt = new Date().toISOString()
        this.#snapshot.thread.push({
          id: `checkpoint-${randomUUID()}`,
          sessionId,
          kind: "checkpoint",
          label: `${checkpoint.commit.slice(0, 8)} · before session archive`,
          commit: checkpoint.commit,
          createdAt: session.updatedAt,
        })
      } else {
        const prior = this.#snapshot.thread.findLast(
          (item) => item.sessionId === sessionId && item.kind === "checkpoint" && item.commit,
        )
        session.archiveCheckpoint = prior?.kind === "checkpoint"
          ? prior.commit
          : session.baseCommit && /^[a-f0-9]{40}$/.test(session.baseCommit)
            ? session.baseCommit
            : undefined
      }
      if (!session.archiveCheckpoint) throw new Error("Session archive has no durable checkpoint")
      await this.#saveAgentState(false)
    }

    if (session.workspacePath) {
      if (!this.#workspaceService.archiveSessionWorkspace) {
        throw new Error("Workspace service cannot preserve archive branches")
      }
      const workspacePath = session.workspacePath
      await this.#withAbortTimeout(
        (signal) => this.#workspaceService.archiveSessionWorkspace!(workspacePath, signal),
        this.#agentTimeoutMs,
        "Archive worktree cleanup timed out",
      )
      delete session.workspacePath
      await this.#saveAgentState(false)
    }

    const archivedAt = new Date().toISOString()
    session.state = "archived"
    session.archivedAt = archivedAt
    session.updatedAt = archivedAt
    this.#snapshot.thread.push({
      id: `system-${randomUUID()}`,
      sessionId,
      kind: "system",
      body: "Session archived.",
      detail: `Final checkpoint ${session.archiveCheckpoint.slice(0, 8)} is retained. Provider, terminal, and isolated worktree resources were cleaned up; the source checkout's branch, HEAD, status, and files remain unchanged.`,
      createdAt: archivedAt,
    })
    await this.#saveAgentState(false)
  }

  async #loadProviderThreadForArchive(
    session: WorkspaceSnapshot["sessions"][number],
  ): Promise<void> {
    if (!session.providerThreadId) return
    const key = providerThreadKey(session.runtime.provider, session.providerThreadId)
    if (this.#loadedAgentThreads.has(key)) return
    if (!session.workspacePath) throw new Error("Archived provider thread has no resumable worktree")
    const agent = await this.#ensureAgentConnected(session.runtime.provider)
    await withTimeout(
      agent.resumeThread({
        threadId: session.providerThreadId,
        cwd: session.workspacePath,
        runtime: session.runtime,
      }),
      this.#agentTimeoutMs,
      "Archive provider resume timed out",
    )
    this.#loadedAgentThreads.add(key)
  }

  #rejectAuthentication(
    socket: WebSocket,
    id: string | number | null,
    message: string,
  ): void {
    this.#error(socket, id, daemonAuthenticationErrorCode, message)
    const failures = (this.#authenticationFailures.get(socket) ?? 0) + 1
    this.#authenticationFailures.set(socket, failures)
    if (failures >= maximumAuthenticationFailures) {
      setTimeout(() => socket.close(1008, "authentication failed"), 0)
    }
  }

  #closeTerminal(terminalId: string): boolean {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal) return false
    this.#terminals.delete(terminalId)
    terminal.disposeData()
    terminal.disposeExit()
    terminal.output.flush(terminalId)
    terminal.outputBackpressure.dispose()
    terminal.process.kill()
    this.#broadcastNotification("terminal.closed", { terminalId })
    return true
  }

  #syncArtifactWatchers(): void {
    const liveSessions = new Map(this.#snapshot.sessions.flatMap((session) =>
      session.workspacePath && !sessionIsArchiveReadOnly(session)
        ? [[session.id, resolve(session.workspacePath)] as const]
        : []
    ))
    for (const [sessionId, active] of this.#artifactWatchers) {
      if (liveSessions.get(sessionId) === active.root) continue
      active.watcher.stop()
      this.#artifactWatchers.delete(sessionId)
    }
    for (const [sessionId, root] of liveSessions) {
      if (this.#artifactWatchers.has(sessionId)) continue
      const watcher = this.#artifactWatcherFactory({
        root,
        onChange: (change) => {
          if (this.#stopping || this.#stopped) return
          void this.#enqueueMutation(() => this.#recordWorktreeArtifact(sessionId, root, change))
        },
        onError: (error) => this.#reportError("Domovoi artifact watcher failed", error),
      })
      const entry = { root, watcher }
      this.#artifactWatchers.set(sessionId, entry)
      void watcher.start().catch((error: unknown) => {
        if (this.#artifactWatchers.get(sessionId) !== entry) return
        watcher.stop()
        this.#artifactWatchers.delete(sessionId)
        this.#reportError("Domovoi could not watch session artifacts", error)
      })
    }
  }

  async #recordWorktreeArtifact(
    sessionId: string,
    root: string,
    change: ArtifactFileChange,
  ): Promise<void> {
    const session = this.#snapshot.sessions.find((candidate) =>
      candidate.id === sessionId
      && candidate.workspacePath
      && resolve(candidate.workspacePath) === root
      && !sessionIsArchiveReadOnly(candidate)
    )
    if (!session) return
    const lexicalPath = resolveInside(root, change.path)
    if (!lexicalPath) return
    try {
      const [metadata, resolvedPath, lexicalMetadata] = await Promise.all([
        stat(lexicalPath),
        resolveInsideReal(root, lexicalPath),
        lstat(lexicalPath),
      ])
      if (
        !resolvedPath
        || !metadata.isFile()
        || lexicalMetadata.isSymbolicLink()
        || metadata.size > maximumArtifactFileBytes
        || (change.content && Buffer.byteLength(change.content, "utf8") > maximumArtifactFileBytes)
      ) return
    } catch {
      return
    }
    const fileHash = createHash("sha256")
      .update(`${sessionId}:${lexicalPath}`)
      .digest("hex")
      .slice(0, 16)
    const artifactId = change.type === "preview"
      ? `preview-${fileHash}`
      : `plan-${sessionId}-${fileHash}`
    const existing = this.#snapshot.artifacts.find((artifact) =>
      artifact.id === artifactId
      && artifact.sessionId === sessionId
      && artifact.type === change.type
    )
    if (existing) {
      existing.title = change.title
      existing.path = change.path
      existing.mimeType = change.mimeType
      if (change.variant === undefined) delete existing.variant
      else existing.variant = change.variant
      if (change.content === undefined) delete existing.content
      else existing.content = change.content
      existing.revision += 1
    } else {
      this.#snapshot.artifacts.push({
        id: artifactId,
        sessionId,
        title: change.title,
        type: change.type,
        revision: 1,
        path: change.path,
        mimeType: change.mimeType,
        ...(change.variant === undefined ? {} : { variant: change.variant }),
        ...(change.content === undefined ? {} : { content: change.content }),
      })
    }
    session.updatedAt = new Date().toISOString()
    await this.#flushAgentState()
  }

  #closeArtifactWatchers(): void {
    for (const { watcher } of this.#artifactWatchers.values()) watcher.stop()
    this.#artifactWatchers.clear()
  }

  #closeSessionTerminals(sessionId: string): void {
    for (const [terminalId, terminal] of this.#terminals) {
      if (terminal.sessionId === sessionId) this.#closeTerminal(terminalId)
    }
  }

  #closeAllTerminals(): void {
    for (const terminalId of [...this.#terminals.keys()]) this.#closeTerminal(terminalId)
  }

  #scheduleDeltaFlush(): void {
    if (this.#deltaFlush) clearTimeout(this.#deltaFlush)
    this.#deltaFlush = setTimeout(() => {
      this.#deltaFlush = undefined
      void this.#flushAgentState(false)
    }, 32)
  }

  async #flushAgentState(broadcast = true): Promise<void> {
    try {
      await this.#saveAgentState(broadcast)
    } catch (error) {
      this.#reportError("Domovoi could not persist agent state", error)
    }
  }

  async #persistSnapshot(): Promise<void> {
    this.#sessionHistory.invalidate()
    if (this.#store.saveAsync) await this.#store.saveAsync(this.#snapshot)
    else this.#store.save(this.#snapshot)
  }

  async #saveAgentState(broadcast = true): Promise<void> {
    if (this.#deltaFlush) {
      clearTimeout(this.#deltaFlush)
      this.#deltaFlush = undefined
    }
    const clientSnapshot = broadcast
      ? structuredClone(workspaceSnapshotForClient(this.#snapshot))
      : undefined
    await this.#persistSnapshot()
    if (clientSnapshot) this.#broadcastNotification("workspace.changed", clientSnapshot)
  }

  async #quarantineProviderThread(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const session = this.#snapshot.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) return
    const threadId = session.providerThreadId
    if (!threadId) return
    const provider = session.runtime.provider
    this.#flushCommandOutputStreams(sessionId)
    delete session.providerThreadId
    delete session.activeTurnId
    session.state = "failed"
    session.updatedAt = new Date().toISOString()
    this.#loadedAgentThreads.delete(providerThreadKey(provider, threadId))
    this.#snapshot.approvals = this.#snapshot.approvals.filter(
      (approval) => approval.sessionId !== session.id,
    )
    this.#snapshot.thread.push({
      id: `system-${randomUUID()}`,
      sessionId: session.id,
      kind: "system",
      body: `Provider thread quarantined after ${redactDurableText(reason).value}.`,
      detail: "The detached provider thread can no longer publish events into this session.",
      createdAt: session.updatedAt,
    })
    try {
      const clientSnapshot = structuredClone(workspaceSnapshotForClient(this.#snapshot))
      await this.#persistSnapshot()
      this.#broadcastNotification("workspace.changed", clientSnapshot)
    } finally {
      try {
        await withTimeout(
          this.#agents.require(provider).stopThread(threadId),
          this.#agentTimeoutMs,
          "Provider quarantine cleanup timed out",
        )
      } catch (error) {
        this.#reportError("Domovoi could not stop a quarantined provider thread", error)
      }
    }
  }

  async #cleanupSessions(): Promise<void> {
    const errors: unknown[] = []
    for (const session of this.#snapshot.sessions) {
      if (session.providerThreadId) {
        try {
          await withTimeout(
            this.#agents.require(session.runtime.provider).stopThread(session.providerThreadId),
            this.#agentTimeoutMs,
            "Agent cleanup timed out",
          )
        } catch (error) {
          errors.push(error)
          this.#reportError("Domovoi could not stop a provider thread", error)
        }
        this.#loadedAgentThreads.delete(
          providerThreadKey(session.runtime.provider, session.providerThreadId),
        )
      }
      if (session.workspacePath) {
        try {
          await this.#withAbortTimeout(
            (signal) => this.#workspaceService.removeSessionWorkspace(
              session.workspacePath!,
              signal,
            ),
            this.#agentTimeoutMs,
            "Session workspace cleanup timed out",
          )
        } catch (error) {
          errors.push(error)
          this.#reportError("Domovoi could not remove a session worktree", error)
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Domovoi could not clean up all sessions")
  }
}

function threadIdForAgentEvent(event: AgentEvent): string | undefined {
  if ("threadId" in event) return event.threadId
  if ("params" in event && typeof event.params.threadId === "string") {
    return event.params.threadId
  }
  return undefined
}

function turnIdForAgentEvent(event: AgentEvent): string | undefined {
  if ("turnId" in event && typeof event.turnId === "string") return event.turnId
  if (!("params" in event)) return undefined
  if (typeof event.params.turnId === "string") return event.params.turnId
  const turn = event.params.turn
  if (turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string") {
    return turn.id
  }
  return undefined
}

function providerThreadKey(provider: string, threadId: string): string {
  return `${provider}\u0000${threadId}`
}

function secureTokenMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

export function canServeArtifacts(host: string, authorized = false): boolean {
  return isLoopbackHost(host) || authorized
}

export function frameAncestorsFor(origins: Iterable<string>): string {
  const sources: string[] = []
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === "file:") sources.push("file:")
      else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        sources.push(parsed.origin)
      }
    } catch {
      continue
    }
  }
  return sources.length > 0 ? [...new Set(sources)].join(" ") : "'none'"
}

export type ArtifactAccessScope = {
  sessionId: string
  artifactId: string
  revision: number
  purpose: ArtifactAccessPurpose
  bridgeChannel?: string
  expiresAt: number
}

function artifactAccessPayload(scope: ArtifactAccessScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.artifactId,
    scope.revision,
    scope.purpose,
    scope.bridgeChannel ?? null,
    scope.expiresAt,
  ])
}

export function signArtifactAccess(
  secret: string,
  scope: ArtifactAccessScope,
): string {
  return createHmac("sha256", secret)
    .update(artifactAccessPayload(scope))
    .digest("base64url")
}

export function artifactAccessMatches(
  secret: string,
  scope: ArtifactAccessScope,
  suppliedSignature: string | null,
  now = Math.floor(Date.now() / 1_000),
): boolean {
  if (
    !scope.sessionId
    || !scope.artifactId
    || !Number.isSafeInteger(scope.revision)
    || scope.revision < 1
    || !Number.isSafeInteger(scope.expiresAt)
    || scope.expiresAt < now
    || (scope.bridgeChannel && scope.purpose !== "preview")
    || typeof suppliedSignature !== "string"
  ) {
    return false
  }
  return secureTokenMatch(
    signArtifactAccess(secret, scope),
    suppliedSignature,
  )
}

export function hostAuthorityMatches(
  authority: string,
  listenerHost: string,
  listenerPort: number,
): boolean {
  if (/[@/?#\\\\]/.test(authority)) return false
  let parsed: URL
  try {
    parsed = new URL(`http://${authority}`)
  } catch {
    return false
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
  const authorityPort = parsed.port === "" ? 80 : Number(parsed.port)
  if (authorityPort !== listenerPort) return false
  if (hostname === listenerHost) return true
  return hostname === "localhost" && isLoopbackHost(listenerHost)
}

function resolveInside(root: string, candidate: string): string | undefined {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(resolvedRoot, candidate)
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate)
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    return resolvedCandidate
  }
  return undefined
}

async function resolveInsideReal(root: string, candidate: string): Promise<string | undefined> {
  const lexicalPath = resolveInside(root, candidate)
  if (!lexicalPath) return undefined
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexicalPath)])
    return resolveInside(realRoot, realCandidate)
  } catch {
    return undefined
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new OperationTimeoutError(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}

async function withLateCleanup<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  cleanup: (value: T) => Promise<void>,
  cleanupErrorMessage: string,
  reportError: (context: string, error: unknown) => void,
): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, message)
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      void promise.then(async (value) => {
        try {
          await withTimeout(cleanup(value), timeoutMs, "Late provider cleanup timed out")
        } catch (cleanupError) {
          reportError(cleanupErrorMessage, cleanupError)
        }
      }, () => undefined)
    }
    throw error
  }
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutError = new OperationTimeoutError(message)
    const startedAt = Date.now()
    let abortFromParent = () => {}
    const cleanup = () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", abortFromParent)
    }
    const timer = setTimeout(() => {
      controller.abort(timeoutError)
      cleanup()
      rejectPromise(timeoutError)
    }, timeoutMs)
    abortFromParent = () => {
      const reason = parentSignal?.reason ?? new Error("Operation aborted")
      controller.abort(reason)
      cleanup()
      rejectPromise(reason)
    }
    if (parentSignal?.aborted) abortFromParent()
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true })
    let operationPromise: Promise<T>
    try {
      controller.signal.throwIfAborted()
      operationPromise = operation(controller.signal)
    } catch (error) {
      cleanup()
      rejectPromise(error)
      return
    }
    operationPromise.then(
      (value) => {
        cleanup()
        if (Date.now() - startedAt > timeoutMs) {
          controller.abort(timeoutError)
          rejectPromise(timeoutError)
          return
        }
        resolvePromise(value)
      },
      (error: unknown) => {
        cleanup()
        rejectPromise(error)
      },
    )
  })
}
