import {
  daemonAuthenticationErrorCode,
  projectSwitchConfirmationErrorCode,
  projectSwitchConfirmationSchema,
  protocolVersion,
  rpcNotificationSchema,
  rpcMethods,
  rpcResponseSchema,
  artifactAuthorizeResultSchema,
  fleetChangedNotificationSchema,
  terminalAcceptedSchema,
  terminalClosedNotificationSchema,
  terminalOwnershipNotificationSchema,
  terminalOutputNotificationSchema,
  terminalSessionSchema,
  systemEmergencyStoppedNotificationSchema,
  workspaceDeltaSchema,
  workspaceSnapshotSchema,
  type ClientKind,
  type ApprovalDecision,
  type Annotation,
  type ArtifactAccess,
  type AuditExportParams,
  type AuditExportResult,
  type DevicePairResult,
  type DeviceRenameParams,
  type DeviceRenameResult,
  type DevicesResult,
  type FleetEnrollParams,
  type FleetEnrollResult,
  type FleetForgetParams,
  type FleetForgetResult,
  type FleetSnapshot,
  type AuditQueryPage,
  type AuditQueryParams,
  type ProviderModel,
  type ProjectSwitchConfirmation,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Runtime,
  type SessionEvidence,
  type SessionHistoryPage,
  type SessionTransferParams,
  type SessionTransferResult,
  type SkillDocument,
  type SkillInstallPreview,
  type SkillInventory,
  type SkillSummary,
  type SystemEmergencyStopResult,
  type TerminalSession,
  type TerminalOwnershipNotification,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { Deadline, DeadlineExceededError, deadlineBudget, describeTarget } from "./deadline.js"

// The daemon's typed error data rides along: a refusal such as a withheld
// fleet list carries facts the surface has to show, and a code alone cannot.
export class DaemonRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "DaemonRpcError"
    this.code = code
    this.data = data
  }
}

export class ProjectSwitchConfirmationError extends Error {
  readonly confirmation: ProjectSwitchConfirmation

  constructor(message: string, confirmation: ProjectSwitchConfirmation) {
    super(message)
    this.name = "ProjectSwitchConfirmationError"
    this.confirmation = confirmation
  }
}

export class DomovoiRpcTimeoutError extends DeadlineExceededError {
  readonly method: RpcMethod
  readonly timeoutMs: number

  constructor(method: RpcMethod, target: string, timeoutMs: number) {
    super(method, target, timeoutMs)
    this.message = `Daemon RPC request ${method} timed out after ${timeoutMs}ms`
    this.name = "DomovoiRpcTimeoutError"
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export type DomovoiConnectStage = "open" | "hello"

export class DomovoiConnectTimeoutError extends DeadlineExceededError {
  override readonly stage: DomovoiConnectStage

  constructor(stage: DomovoiConnectStage, target: string, budgetMs: number) {
    super(stage, target, budgetMs)
    this.name = "DomovoiConnectTimeoutError"
    this.stage = stage
  }
}

// A caller's deadline bounds the request from its side; the client's own
// request budget still applies, so the request ends at whichever comes first.
export type DomovoiRequestOptions = {
  deadline?: Deadline
  signal?: AbortSignal
}

// Neither budget has a default: a client built without them does not compile,
// so no connection or request can be left waiting without end by omission.
export type DomovoiClientBudgets = {
  connectMs: number
  requestMs: number
}

type PendingRequest = {
  parse: (value: unknown) => unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

type DomovoiReconnectTimer = number | ReturnType<typeof globalThis.setTimeout>

export type DomovoiReconnectScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => DomovoiReconnectTimer
  clearTimeout: (timer: DomovoiReconnectTimer) => void
}

export type DomovoiEndpoint = { url: string; token: string }

export type DomovoiClientOptions = {
  budgets: DomovoiClientBudgets
  reconnectDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectJitterRatio?: number
  random?: () => number
  scheduler?: DomovoiReconnectScheduler
  authToken?: string
  clientId?: string
  resolveEndpoint?: () => Promise<DomovoiEndpoint>
}

const defaultReconnectDelayMs = 1_000
const defaultReconnectMaxDelayMs = 30_000
const defaultReconnectJitterRatio = 0.2
const defaultReconnectScheduler: DomovoiReconnectScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("Daemon RPC request aborted", "AbortError")
}

export const maximumReleasedRequests = 256

// Every greeting this package sends carries the same build, so pairing and the
// workspace connection cannot drift apart.
export const clientVersion = "0.0.1"

export class DomovoiClient extends EventTarget {
  #url: string
  readonly kind: ClientKind
  readonly clientId: string
  #socket: WebSocket | undefined
  #requestId = 0
  #pending = new Map<number, PendingRequest>()
  // A request this client gave up on, by cancellation or by its deadline, is
  // still answered by the daemon. That answer is expected, so it is dropped
  // here rather than read as a daemon this client no longer understands.
  #released = new Set<number>()
  #opening: Promise<WorkspaceSnapshot> | undefined
  #cancelOpening: ((error: Error) => void) | undefined
  #reconnectDelayMs: number
  #reconnectMaxDelayMs: number
  #reconnectJitterRatio: number
  #random: () => number
  #scheduler: DomovoiReconnectScheduler
  #reconnectTimer: DomovoiReconnectTimer | undefined
  #reconnectAttempt = 0
  #connectionGeneration = 0
  #authenticationTerminal = false
  #shouldReconnect = false
  #authToken: string | undefined
  #resolveEndpoint: (() => Promise<DomovoiEndpoint>) | undefined
  #budgets: DomovoiClientBudgets
  #socketListeners: AbortController | undefined

  constructor(url: string, kind: ClientKind, options: DomovoiClientOptions) {
    super()
    this.#url = url
    this.kind = kind
    this.#budgets = {
      connectMs: deadlineBudget(options.budgets.connectMs, "Connect budget"),
      requestMs: deadlineBudget(options.budgets.requestMs, "Request budget"),
    }
    this.clientId = options.clientId ?? crypto.randomUUID()
    this.#reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs
    this.#reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs
    this.#reconnectJitterRatio = options.reconnectJitterRatio ?? defaultReconnectJitterRatio
    if (!Number.isFinite(this.#reconnectDelayMs) || this.#reconnectDelayMs <= 0) {
      throw new RangeError("Reconnect delay must be positive")
    }
    if (
      !Number.isFinite(this.#reconnectMaxDelayMs)
      || this.#reconnectMaxDelayMs < this.#reconnectDelayMs
    ) {
      throw new RangeError("Reconnect maximum delay must be at least the base delay")
    }
    if (
      !Number.isFinite(this.#reconnectJitterRatio)
      || this.#reconnectJitterRatio < 0
      || this.#reconnectJitterRatio > 1
    ) {
      throw new RangeError("Reconnect jitter ratio must be between 0 and 1")
    }
    this.#random = options.random ?? Math.random
    this.#scheduler = options.scheduler ?? defaultReconnectScheduler
    this.#authToken = options.authToken
    this.#resolveEndpoint = options.resolveEndpoint
  }

  // The address this client last dialed. With a resolver it follows the owner
  // across restarts instead of the address given at construction.
  get url(): string {
    return this.#url
  }

  // A caller that is trying several routes for one connection passes the
  // deadline they share; this attempt then gets the smaller of what remains
  // and the client's own connect budget. Reconnect attempts the client starts
  // on its own each get the full connect budget.
  connect(deadline?: Deadline): Promise<WorkspaceSnapshot> {
    this.#shouldReconnect = true
    this.#authenticationTerminal = false
    // A connection asked for explicitly is a fresh start, so the next failure
    // waits the first backoff rather than one escalated by earlier attempts.
    this.#reconnectAttempt = 0
    this.#clearReconnectTimer()
    return this.#open(deadline)
  }

  #open(shared?: Deadline): Promise<WorkspaceSnapshot> {
    if (this.#opening) return this.#opening
    if (this.#socket) return Promise.reject(new Error("Daemon connection is already open"))

    // The clock starts before the socket exists, so open and hello draw on the
    // one budget and a slow open leaves the hello only what it did not use.
    const deadline = shared
      ? shared.limit(this.#budgets.connectMs)
      : Deadline.start(this.#budgets.connectMs)
    if (deadline.expired) {
      return Promise.reject(
        new DomovoiConnectTimeoutError("open", describeTarget(this.#url), deadline.budgetMs),
      )
    }

    const generation = ++this.#connectionGeneration
    const listeners = new AbortController()
    this.#socketListeners = listeners
    const opening = new Promise<WorkspaceSnapshot>((resolve, reject) => {
      const dial = () => {
        const socket = new WebSocket(this.#url)
        this.#socket = socket
        let opening = true
        let stage: DomovoiConnectStage = "open"
        const rejectOpening = (error: Error) => {
          if (!opening) return
          opening = false
          reject(error)
        }
        this.#cancelOpening = rejectOpening
        const current = () => socket === this.#socket && generation === this.#connectionGeneration
        deadline.signal.addEventListener("abort", () => {
          if (!current()) return
          // Everything this attempt owns goes before the next one starts: the
          // socket is detached so its late events find nothing, its listeners
          // are removed, and the hello it may have sent is no longer awaited.
          const error = new DomovoiConnectTimeoutError(stage, describeTarget(this.#url), deadline.budgetMs)
          this.#socket = undefined
          listeners.abort()
          rejectOpening(error)
          this.#rejectPending(error)
          socket.close()
          this.dispatchEvent(new Event("disconnected"))
          this.#scheduleReconnect()
        }, { once: true, signal: listeners.signal })
        socket.addEventListener("error", () => {
          if (!current()) return
          rejectOpening(new Error(`Cannot reach ${this.#url}`))
          socket.close()
        }, { once: true, signal: listeners.signal })
        socket.addEventListener(
          "open",
          () => {
            if (!current() || !this.#shouldReconnect) return
            stage = "hello"
            this.request("system.hello", {
              client: this.kind,
              clientId: this.clientId,
              clientVersion,
              protocolVersion,
              ...(this.#authToken ? { authToken: this.#authToken } : {}),
            }, { deadline }).then(
              (snapshot) => {
                if (socket !== this.#socket || generation !== this.#connectionGeneration) return
                opening = false
                this.#reconnectAttempt = 0
                this.#authenticationTerminal = false
                this.dispatchEvent(new CustomEvent("snapshot", { detail: snapshot }))
                this.dispatchEvent(new Event("connected"))
                resolve(snapshot)
              },
              (cause: unknown) => {
                const error = cause instanceof Error ? cause : new Error("Daemon handshake failed")
                rejectOpening(error)
                socket.close()
              },
            )
          },
          { once: true, signal: listeners.signal },
        )
        socket.addEventListener("message", (event) => {
          if (current()) this.#receive(String(event.data))
        }, { signal: listeners.signal })
        socket.addEventListener("close", (event) => {
          if (!current()) return
          this.#socket = undefined
          const error = new Error("Daemon connection closed")
          rejectOpening(error)
          this.#rejectPending(error)
          // A policy close is terminal whatever it says: a revoked device is
          // refused for the same reason a bad credential is, and retrying only
          // presents a credential the machine will keep refusing.
          if (event.code === 1008) {
            this.#markAuthenticationRequired(event.reason || "Daemon authentication required")
          }
          this.dispatchEvent(new Event("disconnected"))
          this.#scheduleReconnect()
        }, { signal: listeners.signal })
      }
      const resolveEndpoint = this.#resolveEndpoint
      if (!resolveEndpoint) {
        dial()
        return
      }
      // Resolution shares the connect budget and runs before every attempt,
      // so the owner's current endpoint is what gets dialed rather than the
      // address this client started with. A resolver that refuses is the
      // failure of this attempt, and the backoff loop asks it again.
      let resolving = true
      const failResolution = (error: Error) => {
        if (!resolving) return
        resolving = false
        reject(error)
      }
      this.#cancelOpening = failResolution
      const abandon = (error: Error) => {
        if (!resolving || generation !== this.#connectionGeneration) return
        failResolution(error)
        this.dispatchEvent(new Event("disconnected"))
        this.#scheduleReconnect()
      }
      const expire = () => abandon(new DomovoiConnectTimeoutError("open", describeTarget(this.#url), deadline.budgetMs))
      deadline.signal.addEventListener("abort", expire, { once: true, signal: listeners.signal })
      resolveEndpoint().then((endpoint) => {
        if (!resolving || generation !== this.#connectionGeneration) return
        resolving = false
        deadline.signal.removeEventListener("abort", expire)
        this.#url = endpoint.url
        this.#authToken = endpoint.token
        dial()
      }, (cause: unknown) => {
        abandon(cause instanceof Error ? cause : new Error("Daemon endpoint could not be resolved"))
      })
    })
    this.#opening = opening
    const settled = () => {
      deadline.clear()
      if (this.#opening === opening) {
        this.#opening = undefined
        this.#cancelOpening = undefined
      }
    }
    void opening.then(settled, settled)
    return opening
  }

  disconnect(): void {
    this.#shouldReconnect = false
    this.#connectionGeneration += 1
    this.#clearReconnectTimer()
    const socket = this.#socket
    this.#socket = undefined
    this.#socketListeners?.abort()
    this.#socketListeners = undefined
    this.#cancelOpening?.(new Error("Daemon connection closed"))
    this.#cancelOpening = undefined
    this.#opening = undefined
    this.#rejectPending(new Error("Daemon connection closed"))
    socket?.close(1000, "client closed")
  }

  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options?: DomovoiRequestOptions,
  ): Promise<RpcResult<M>>
  request<M extends RpcMethod, T>(
    method: M,
    params: RpcParams<M>,
    parse: (value: unknown) => T,
    options?: DomovoiRequestOptions,
  ): Promise<T>
  request<M extends RpcMethod, T>(
    method: M,
    params: RpcParams<M>,
    parseOrOptions?: ((value: unknown) => T) | DomovoiRequestOptions,
    requestOptions: DomovoiRequestOptions = {},
  ): Promise<T> {
    const id = ++this.#requestId
    const parse = typeof parseOrOptions === "function" ? parseOrOptions : undefined
    const options = typeof parseOrOptions === "function" ? requestOptions : (parseOrOptions ?? {})
    const resultParser = parse ?? ((value: unknown) => rpcMethods[method].result.parse(value) as T)
    const target = describeTarget(this.#url)
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Daemon connection is not open"))
        return
      }
      if (options.deadline?.expired) {
        reject(new DomovoiRpcTimeoutError(method, target, options.deadline.budgetMs))
        return
      }
      if (options.signal?.aborted) {
        reject(requestAbortError(options.signal))
        return
      }

      const deadline = options.deadline
        ? options.deadline.limit(this.#budgets.requestMs)
        : Deadline.start(this.#budgets.requestMs)
      const onAbort = () => {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        this.#release(id)
        pending.cleanup()
        pending.reject(requestAbortError(options.signal!))
      }
      const onExpire = () => {
        if (this.#pending.get(id) !== pending) return
        this.#pending.delete(id)
        this.#release(id)
        pending.cleanup()
        pending.reject(new DomovoiRpcTimeoutError(method, target, deadline.budgetMs))
      }
      const cleanup = () => {
        deadline.clear()
        deadline.signal.removeEventListener("abort", onExpire)
        options.signal?.removeEventListener("abort", onAbort)
      }
      const pending: PendingRequest = {
        parse: resultParser,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      }
      this.#pending.set(id, pending)
      deadline.signal.addEventListener("abort", onExpire, { once: true })
      options.signal?.addEventListener("abort", onAbort, { once: true })
      if (deadline.expired) {
        onExpire()
        return
      }

      try {
        this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (cause) {
        if (this.#pending.get(id) === pending) this.#pending.delete(id)
        pending.cleanup()
        pending.reject(cause instanceof Error ? cause : new Error("Daemon RPC request failed"))
      }
    })
  }

  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ): Promise<WorkspaceSnapshot> {
    return this.request("approval.resolve", {
      approvalId,
      decision,
      ...(explanation ? { explanation } : {}),
    })
  }

  setRuntime(sessionId: string, runtime: Runtime): Promise<WorkspaceSnapshot> {
    return this.request("session.setRuntime", { sessionId, runtime, client: this.kind })
  }

  restartProviderThread(sessionId: string, runtime?: Runtime): Promise<WorkspaceSnapshot> {
    return this.request("session.restartProviderThread", {
      sessionId,
      client: this.kind,
      ...(runtime ? { runtime } : {}),
    })
  }

  editPlan(
    params: {
      sessionId: string
      basedOnStructureRevision: number
      baseSteps: RpcParams<"plan.edit">["baseSteps"]
      draftSteps: RpcParams<"plan.edit">["draftSteps"]
      replacesPendingEditId?: string
    },
    options?: DomovoiRequestOptions,
  ): Promise<RpcResult<"plan.edit">> {
    return this.request("plan.edit", { ...params, client: this.kind }, options)
  }

  discardPlanEdit(
    params: { sessionId: string, editId: string },
    options?: DomovoiRequestOptions,
  ): Promise<RpcResult<"plan.discardEdit">> {
    return this.request("plan.discardEdit", { ...params, client: this.kind }, options)
  }

  activateSession(sessionId: string): Promise<WorkspaceSnapshot> {
    return this.request("session.activate", { sessionId, client: this.kind })
  }

  openProject(path: string, confirmation?: ProjectSwitchConfirmation): Promise<WorkspaceSnapshot> {
    return this.request("project.open", {
      path,
      client: this.kind,
      ...(confirmation ? { confirmation } : {}),
    })
  }

  createSession(title: string, runtime: Runtime): Promise<WorkspaceSnapshot> {
    return this.request("session.create", { title, runtime, client: this.kind })
  }

  forkSession(
    input: Omit<RpcParams<"session.fork">, "client">,
  ): Promise<WorkspaceSnapshot> {
    return this.request("session.fork", {
      ...input,
      client: this.kind,
    })
  }

  sendMessage(
    sessionId: string,
    prompt: string,
    skillSelection?: RpcParams<"session.send">["skillSelection"],
  ): Promise<WorkspaceSnapshot> {
    return this.request("session.send", {
      sessionId,
      prompt,
      client: this.kind,
      ...(skillSelection ? { skillSelection } : {}),
    })
  }

  revertSessionFile(sessionId: string, path: string): Promise<WorkspaceSnapshot> {
    return this.request("session.revertFile", { sessionId, path, client: this.kind })
  }

  createCheckpoint(sessionId: string, label?: string): Promise<WorkspaceSnapshot> {
    return this.request("checkpoint.create", {
      sessionId,
      client: this.kind,
      ...(label ? { label } : {}),
    })
  }

  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<WorkspaceSnapshot> {
    return this.request("checkpoint.restore", {
      sessionId,
      checkpointId,
      client: this.kind,
    })
  }

  pauseAll(): Promise<WorkspaceSnapshot> {
    return this.request("system.pauseAll", { client: this.kind })
  }

  emergencyStop(): Promise<SystemEmergencyStopResult> {
    return this.request("system.emergencyStop", { client: this.kind })
  }

  pauseSession(sessionId: string): Promise<WorkspaceSnapshot> {
    return this.request("session.pause", { sessionId, client: this.kind })
  }

  loadSessionEvidence(sessionId: string): Promise<SessionEvidence> {
    return this.request("session.evidence", { sessionId })
  }

  archiveSession(sessionId: string): Promise<WorkspaceSnapshot> {
    return this.request("session.archive", { sessionId, client: this.kind })
  }

  loadSessionHistory(
    sessionId: string,
    options: Omit<RpcParams<"session.history">, "sessionId"> = { limit: 50 },
    requestOptions: DomovoiRequestOptions = {},
  ): Promise<SessionHistoryPage> {
    return this.request(
      "session.history",
      {
        sessionId,
        ...options,
        limit: options.limit ?? 50,
      },
      requestOptions,
    )
  }

  authorizeArtifact(input: {
    sessionId: string
    artifactId: string
    revision: number
    purpose: ArtifactAccess["purpose"]
    bridgeChannel?: string
    parentOrigin?: string
  }): Promise<ArtifactAccess> {
    return this.request(
      "artifact.authorize",
      {
        ...input,
        client: this.kind,
      },
      (value) => artifactAuthorizeResultSchema.parse(value),
    )
  }

  createTerminal(
    sessionId: string,
    dimensions: { cols: number; rows: number },
    terminalId: string = crypto.randomUUID(),
  ): Promise<TerminalSession> {
    return this.request(
      "terminal.create",
      { terminalId, sessionId, ...dimensions, client: this.kind, clientId: this.clientId },
      (value) => terminalSessionSchema.parse(value),
    )
  }

  writeTerminal(terminalId: string, data: string): Promise<void> {
    return this.#terminalCommand("terminal.input", {
      terminalId,
      data,
      client: this.kind,
      clientId: this.clientId,
    })
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.#terminalCommand("terminal.resize", {
      terminalId,
      cols,
      rows,
      client: this.kind,
      clientId: this.clientId,
    })
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.#terminalCommand("terminal.close", {
      terminalId,
      client: this.kind,
      clientId: this.clientId,
    })
  }

  claimTerminal(terminalId: string): Promise<TerminalOwnershipNotification> {
    return this.request(
      "terminal.claim",
      { terminalId, client: this.kind, clientId: this.clientId },
      (value) => terminalOwnershipNotificationSchema.parse(value),
    )
  }

  #terminalCommand<M extends "terminal.input" | "terminal.resize" | "terminal.close">(
    method: M,
    params: RpcParams<M>,
  ): Promise<void> {
    return this.request(method, params, (value) => {
      terminalAcceptedSchema.parse(value)
    })
  }

  createAnnotation(input: {
    sessionId: string
    artifactId: string
    variantId?: string
    anchor: Annotation["anchor"]
    body: string
    visualContextUpload?: RpcParams<"annotation.create">["visualContextUpload"]
  }): Promise<WorkspaceSnapshot> {
    return this.request("annotation.create", { ...input, client: this.kind })
  }

  replyToAnnotation(annotationId: string, body: string): Promise<WorkspaceSnapshot> {
    return this.request("annotation.reply", { annotationId, body, client: this.kind })
  }

  setAnnotationStatus(
    annotationId: string,
    status: Annotation["status"],
  ): Promise<WorkspaceSnapshot> {
    return this.request("annotation.setStatus", { annotationId, status, client: this.kind })
  }

  listModels(provider: string): Promise<ProviderModel[]> {
    return this.request("runtime.models", { provider, client: this.kind })
  }

  refreshProviders(): Promise<WorkspaceSnapshot> {
    return this.request("provider.refresh", { client: this.kind })
  }

  listProviderSecrets(): Promise<RpcResult<"provider.secret.list">> {
    return this.request("provider.secret.list", {})
  }

  sessionUsage(sessionId: string): Promise<RpcResult<"session.usage">> {
    return this.request("session.usage", { sessionId })
  }

  usageWindow(window: RpcParams<"usage.window">): Promise<RpcResult<"usage.window">> {
    return this.request("usage.window", window)
  }

  listSkills(options?: DomovoiRequestOptions): Promise<SkillSummary[]> {
    return this.request("skill.list", {}, options)
  }

  getSkillInventory(options?: DomovoiRequestOptions): Promise<SkillInventory> {
    return this.request("skill.inventory", {}, options)
  }

  readSkill(id: string): Promise<SkillDocument> {
    return this.request("skill.read", { id })
  }

  setSkillEnabled(
    params: RpcParams<"skill.setEnabled">,
  ): Promise<WorkspaceSnapshot> {
    return this.request("skill.setEnabled", params)
  }

  reviewSkill(params: RpcParams<"skill.review">): Promise<SkillSummary> {
    return this.request("skill.review", params)
  }

  previewSkillInstall(
    params: RpcParams<"skill.installPreview">,
  ): Promise<SkillInstallPreview> {
    return this.request("skill.installPreview", params)
  }

  installSkill(params: RpcParams<"skill.install">): Promise<SkillSummary> {
    return this.request("skill.install", params)
  }

  queryAudit(
    params: AuditQueryParams,
    options?: DomovoiRequestOptions,
  ): Promise<AuditQueryPage> {
    return this.request("audit.query", params, options)
  }

  listFleet(options?: DomovoiRequestOptions): Promise<FleetSnapshot> {
    return this.request("fleet.list", {}, options)
  }

  // Moving a session is one request that either lands, is refused with a
  // reason, or fails. The caller renders whichever came back.
  previewSessionTransfer(
    params: Omit<RpcParams<"session.transferPreview">, "initiatedByClient">,
    options?: DomovoiRequestOptions,
  ): Promise<RpcResult<"session.transferPreview">> {
    return this.request(
      "session.transferPreview",
      { ...params, initiatedByClient: this.kind },
      options,
    )
  }

  transferSession(
    params: Omit<SessionTransferParams, "initiatedByClient">,
    options?: DomovoiRequestOptions,
  ): Promise<SessionTransferResult> {
    return this.request("session.transfer", { ...params, initiatedByClient: this.kind }, options)
  }

  // Two exits from a stalled move, and the confirmation the operator made
  // decides which one is called. Routing here rather than at the surface keeps
  // the claim they agreed to and the method that acts on it together.
  releaseSession(
    params: {
      sessionId: string
      transferId: string
      confirmation: "target-does-not-have-session" | "keep-target-session"
    },
    options?: DomovoiRequestOptions,
  ): Promise<unknown> {
    if (params.confirmation === "keep-target-session") {
      return this.request("session.transferResolveConflict", {
        sessionId: params.sessionId,
        transferId: params.transferId,
        confirmation: "keep-target-session",
        initiatedByClient: this.kind,
      }, options)
    }
    return this.request("session.transferRecoverSource", {
      sessionId: params.sessionId,
      transferId: params.transferId,
      confirmation: "target-does-not-have-session",
      initiatedByClient: this.kind,
    }, options)
  }

  listDevices(options?: DomovoiRequestOptions): Promise<DevicesResult> {
    return this.request("device.list", {}, options)
  }

  revokeDevice(
    params: { deviceId: string },
    options?: DomovoiRequestOptions,
  ): Promise<RpcResult<"device.revoke">> {
    return this.request("device.revoke", { ...params, client: this.kind }, options)
  }

  rotateDevice(
    params: { deviceId: string },
    options?: DomovoiRequestOptions,
  ): Promise<DevicePairResult> {
    return this.request("device.rotate", { ...params, client: this.kind }, options)
  }

  renameDevice(
    params: DeviceRenameParams,
    options?: DomovoiRequestOptions,
  ): Promise<DeviceRenameResult> {
    return this.request("device.rename", params, options)
  }

  // The daemon claims, greets and stores on the client's behalf, so the only
  // thing this connection ever carries is the one-time code and the answer.
  enrollMachine(
    params: Omit<FleetEnrollParams, "client">,
    options?: DomovoiRequestOptions,
  ): Promise<FleetEnrollResult> {
    return this.request("fleet.enroll", { ...params, client: this.kind }, options)
  }

  forgetMachine(
    params: Omit<FleetForgetParams, "client">,
    options?: DomovoiRequestOptions,
  ): Promise<FleetForgetResult> {
    return this.request("fleet.forget", { ...params, client: this.kind }, options)
  }

  exportAudit(
    params: AuditExportParams,
    options?: DomovoiRequestOptions,
  ): Promise<AuditExportResult> {
    return this.request("audit.export", params, options)
  }

  #scheduleReconnect(): void {
    if (
      !this.#shouldReconnect
      || this.#authenticationTerminal
      || this.#reconnectTimer !== undefined
      || this.#socket
    ) return
    const exponentialDelay = Math.min(
      this.#reconnectMaxDelayMs,
      this.#reconnectDelayMs * (2 ** Math.min(this.#reconnectAttempt, 30)),
    )
    const random = Math.min(1, Math.max(0, this.#random()))
    const jitterMultiplier = 1 - this.#reconnectJitterRatio + (2 * this.#reconnectJitterRatio * random)
    const delayMs = Math.min(
      this.#reconnectMaxDelayMs,
      Math.round(exponentialDelay * jitterMultiplier),
    )
    this.#reconnectAttempt += 1
    const generation = this.#connectionGeneration
    this.#reconnectTimer = this.#scheduler.setTimeout(() => {
      this.#reconnectTimer = undefined
      this.dispatchEvent(new CustomEvent("reconnecting", { detail: { active: false } }))
      if (
        generation !== this.#connectionGeneration
        || !this.#shouldReconnect
        || this.#authenticationTerminal
        || this.#socket
      ) return
      void this.#open().catch(() => undefined)
    }, delayMs)
    this.dispatchEvent(new CustomEvent("reconnecting", { detail: { active: true } }))
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    this.#scheduler.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.dispatchEvent(new CustomEvent("reconnecting", { detail: { active: false } }))
  }

  #markAuthenticationRequired(message: string): void {
    if (this.#authenticationTerminal) return
    this.#authenticationTerminal = true
    this.#clearReconnectTimer()
    this.dispatchEvent(new CustomEvent("authentication-required", {
      detail: { message, action: "update-credentials-or-reconnect" },
    }))
  }

  #rejectPending(error: Error): void {
    const pendingRequests = [...this.#pending.values()]
    this.#pending.clear()
    for (const pending of pendingRequests) {
      pending.cleanup()
      pending.reject(error)
    }
  }

  // Bounded so a daemon that never answers cannot grow this set without end;
  // the oldest release is forgotten first, since its answer is the least due.
  #release(id: number): void {
    if (this.#released.size >= maximumReleasedRequests) {
      const oldest = this.#released.values().next()
      if (!oldest.done) this.#released.delete(oldest.value)
    }
    this.#released.add(id)
  }

  #reportProtocolError(reason: string): void {
    this.dispatchEvent(new CustomEvent("protocol-error", { detail: { reason } }))
  }

  #receive(raw: string): void {
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      this.#reportProtocolError("Daemon sent a message that is not valid JSON")
      return
    }

    const notification = rpcNotificationSchema.safeParse(input)
    if (notification.success) {
      if (notification.data.method === "workspace.changed") {
        const snapshot = workspaceSnapshotSchema.safeParse(notification.data.params)
        if (snapshot.success) {
          this.dispatchEvent(new CustomEvent("snapshot", { detail: snapshot.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a workspace.changed notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "workspace.delta") {
        const delta = workspaceDeltaSchema.safeParse(notification.data.params)
        if (delta.success) {
          this.dispatchEvent(new CustomEvent("workspace-delta", { detail: delta.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a workspace.delta notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "system.emergencyStopped") {
        const stopped = systemEmergencyStoppedNotificationSchema.safeParse(
          notification.data.params,
        )
        if (stopped.success) {
          this.dispatchEvent(new CustomEvent("emergency-stopped", { detail: stopped.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a system.emergencyStopped notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "fleet.changed") {
        const fleet = fleetChangedNotificationSchema.safeParse(notification.data.params)
        if (fleet.success) {
          this.dispatchEvent(new CustomEvent("fleet-changed", { detail: fleet.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a fleet.changed notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "terminal.output") {
        const output = terminalOutputNotificationSchema.safeParse(notification.data.params)
        if (output.success) {
          this.dispatchEvent(new CustomEvent("terminal-output", { detail: output.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a terminal.output notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "terminal.closed") {
        const closed = terminalClosedNotificationSchema.safeParse(notification.data.params)
        if (closed.success) {
          this.dispatchEvent(new CustomEvent("terminal-closed", { detail: closed.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a terminal.closed notification this client could not parse",
          )
        }
        return
      }
      if (notification.data.method === "terminal.ownership") {
        const ownership = terminalOwnershipNotificationSchema.safeParse(
          notification.data.params,
        )
        if (ownership.success) {
          this.dispatchEvent(new CustomEvent("terminal-ownership", { detail: ownership.data }))
        } else {
          this.#reportProtocolError(
            "Daemon sent a terminal.ownership notification this client could not parse",
          )
        }
        return
      }
      this.#reportProtocolError(
        `Daemon sent a ${notification.data.method} notification this client does not recognize`,
      )
      return
    }

    const response = rpcResponseSchema.safeParse(input)
    if (!response.success) {
      const id = (input as { id?: unknown }).id
      if (typeof id === "number") {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#pending.delete(id)
          pending.cleanup()
          pending.reject(new Error("Daemon returned a response this client could not parse"))
        }
        this.#reportProtocolError(
          "Daemon sent an RPC response this client could not parse",
        )
      } else {
        this.#reportProtocolError(
          "Daemon sent a message this client could not classify",
        )
      }
      return
    }
    if (typeof response.data.id !== "number") {
      this.#reportProtocolError("Daemon sent an RPC response without a request id")
      return
    }
    const pending = this.#pending.get(response.data.id)
    if (!pending) {
      if (this.#released.delete(response.data.id)) return
      this.#reportProtocolError(
        "Daemon sent a response for a request this client is not tracking",
      )
      return
    }
    this.#pending.delete(response.data.id)
    pending.cleanup()

    if (response.data.error) {
      const error = new DaemonRpcError(response.data.error.code, response.data.error.message, response.data.error.data)
      if (response.data.error.code === daemonAuthenticationErrorCode) {
        pending.reject(error)
        this.#markAuthenticationRequired(response.data.error.message)
        const socket = this.#socket
        queueMicrotask(() => {
          if (socket === this.#socket) socket?.close(1000, "authentication required")
        })
        return
      }
      if (response.data.error.code === projectSwitchConfirmationErrorCode) {
        const confirmation = projectSwitchConfirmationSchema.safeParse(response.data.error.data)
        if (confirmation.success) {
          pending.reject(new ProjectSwitchConfirmationError(
            response.data.error.message,
            confirmation.data,
          ))
          return
        }
      }
      pending.reject(error)
      return
    }

    try {
      pending.resolve(pending.parse(response.data.result))
    } catch (cause) {
      pending.reject(new Error("Daemon returned an invalid RPC result", { cause }))
    }
  }
}
