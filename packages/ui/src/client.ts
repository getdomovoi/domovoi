import {
  daemonAuthenticationErrorCode,
  projectSwitchConfirmationErrorCode,
  projectSwitchConfirmationSchema,
  rpcNotificationSchema,
  rpcMethods,
  rpcResponseSchema,
  artifactAuthorizeResultSchema,
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
  type DeviceMachineCredentialParams,
  type FleetSnapshot,
  type DeviceMachineCredentialResult,
  type DeviceSaveCredentialParams,
  type DeviceSaveCredentialResult,
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
  type SkillDocument,
  type SkillInventory,
  type SkillSummary,
  type SystemEmergencyStopResult,
  type TerminalSession,
  type TerminalOwnershipNotification,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

export class DaemonRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "DaemonRpcError"
    this.code = code
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

export class DomovoiRpcTimeoutError extends Error {
  readonly method: RpcMethod
  readonly timeoutMs: number

  constructor(method: RpcMethod, timeoutMs: number) {
    super(`Daemon RPC request ${method} timed out after ${timeoutMs}ms`)
    this.name = "DomovoiRpcTimeoutError"
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export type DomovoiRequestOptions = {
  timeoutMs?: number
  signal?: AbortSignal
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

type DomovoiClientOptions = {
  reconnectDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectJitterRatio?: number
  random?: () => number
  scheduler?: DomovoiReconnectScheduler
  requestTimeoutMs?: number
  authToken?: string
  clientId?: string
}

const defaultRequestTimeoutMs = 120_000
const maximumRequestTimeoutMs = 2_147_483_647
const defaultReconnectDelayMs = 1_000
const defaultReconnectMaxDelayMs = 30_000
const defaultReconnectJitterRatio = 0.2
const defaultReconnectScheduler: DomovoiReconnectScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function requestTimeout(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumRequestTimeoutMs) {
    throw new RangeError(
      `RPC request timeout must be between 1 and ${maximumRequestTimeoutMs} milliseconds`,
    )
  }
  return timeoutMs
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("Daemon RPC request aborted", "AbortError")
}

export class DomovoiClient extends EventTarget {
  readonly url: string
  readonly kind: ClientKind
  readonly clientId: string
  #socket: WebSocket | undefined
  #requestId = 0
  #pending = new Map<number, PendingRequest>()
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
  #requestTimeoutMs: number

  constructor(url: string, kind: ClientKind, options: DomovoiClientOptions = {}) {
    super()
    this.url = url
    this.kind = kind
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
    this.#requestTimeoutMs = requestTimeout(options.requestTimeoutMs, defaultRequestTimeoutMs)
    this.#authToken = options.authToken
  }

  connect(): Promise<WorkspaceSnapshot> {
    this.#shouldReconnect = true
    this.#authenticationTerminal = false
    this.#clearReconnectTimer()
    return this.#open()
  }

  #open(): Promise<WorkspaceSnapshot> {
    if (this.#opening) return this.#opening
    if (this.#socket) return Promise.reject(new Error("Daemon connection is already open"))

    const generation = ++this.#connectionGeneration
    const opening = new Promise<WorkspaceSnapshot>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.#socket = socket
      let opening = true
      const rejectOpening = (error: Error) => {
        if (!opening) return
        opening = false
        reject(error)
      }
      this.#cancelOpening = rejectOpening
      socket.addEventListener("error", () => {
        if (socket !== this.#socket || generation !== this.#connectionGeneration) return
        rejectOpening(new Error(`Cannot reach ${this.url}`))
        socket.close()
      }, { once: true })
      socket.addEventListener(
        "open",
        () => {
          if (
            socket !== this.#socket
            || generation !== this.#connectionGeneration
            || !this.#shouldReconnect
          ) return
          this.request("system.hello", {
            client: this.kind,
            clientId: this.clientId,
            clientVersion: "0.0.1",
            ...(this.#authToken ? { authToken: this.#authToken } : {}),
          }).then(
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
        { once: true },
      )
      socket.addEventListener("message", (event) => {
        if (socket === this.#socket && generation === this.#connectionGeneration) {
          this.#receive(String(event.data))
        }
      })
      socket.addEventListener("close", (event) => {
        if (socket !== this.#socket || generation !== this.#connectionGeneration) return
        this.#socket = undefined
        const error = new Error("Daemon connection closed")
        rejectOpening(error)
        this.#rejectPending(error)
        if (event.code === 1008 && /auth/i.test(event.reason)) {
          this.#markAuthenticationRequired(event.reason || "Daemon authentication required")
        }
        this.dispatchEvent(new Event("disconnected"))
        this.#scheduleReconnect()
      })
    })
    this.#opening = opening
    void opening.then(
      () => {
        if (this.#opening === opening) {
          this.#opening = undefined
          this.#cancelOpening = undefined
        }
      },
      () => {
        if (this.#opening === opening) {
          this.#opening = undefined
          this.#cancelOpening = undefined
        }
      },
    )
    return opening
  }

  disconnect(): void {
    this.#shouldReconnect = false
    this.#connectionGeneration += 1
    this.#clearReconnectTimer()
    const socket = this.#socket
    this.#socket = undefined
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
    const timeoutMs = requestTimeout(options.timeoutMs, this.#requestTimeoutMs)
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Daemon connection is not open"))
        return
      }
      if (options.signal?.aborted) {
        reject(requestAbortError(options.signal))
        return
      }

      const onAbort = () => {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        pending.cleanup()
        pending.reject(requestAbortError(options.signal!))
      }
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
      }
      const pending: PendingRequest = {
        parse: resultParser,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      }
      this.#pending.set(id, pending)
      const timer = setTimeout(() => {
        if (this.#pending.get(id) !== pending) return
        this.#pending.delete(id)
        pending.cleanup()
        pending.reject(new DomovoiRpcTimeoutError(method, timeoutMs))
      }, timeoutMs)
      options.signal?.addEventListener("abort", onAbort, { once: true })

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

  sendMessage(sessionId: string, prompt: string): Promise<WorkspaceSnapshot> {
    return this.request("session.send", { sessionId, prompt, client: this.kind })
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

  listSkills(): Promise<SkillSummary[]> {
    return this.request("skill.list", {})
  }

  getSkillInventory(): Promise<SkillInventory> {
    return this.request("skill.inventory", {})
  }

  readSkill(id: string): Promise<SkillDocument> {
    return this.request("skill.read", { id })
  }

  setSkillEnabled(
    params: RpcParams<"skill.setEnabled">,
  ): Promise<WorkspaceSnapshot> {
    return this.request("skill.setEnabled", params)
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

  machineCredential(
    params: DeviceMachineCredentialParams,
    options?: DomovoiRequestOptions,
  ): Promise<DeviceMachineCredentialResult> {
    return this.request("device.machineCredential", params, options)
  }

  saveMachineCredential(
    params: DeviceSaveCredentialParams,
    options?: DomovoiRequestOptions,
  ): Promise<DeviceSaveCredentialResult> {
    return this.request("device.saveCredential", params, options)
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
      if (
        generation !== this.#connectionGeneration
        || !this.#shouldReconnect
        || this.#authenticationTerminal
        || this.#socket
      ) return
      void this.#open().catch(() => undefined)
    }, delayMs)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    this.#scheduler.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
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

  #receive(raw: string): void {
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      return
    }

    const notification = rpcNotificationSchema.safeParse(input)
    if (notification.success) {
      if (notification.data.method === "workspace.changed") {
        const snapshot = workspaceSnapshotSchema.safeParse(notification.data.params)
        if (snapshot.success) {
          this.dispatchEvent(new CustomEvent("snapshot", { detail: snapshot.data }))
        }
        return
      }
      if (notification.data.method === "workspace.delta") {
        const delta = workspaceDeltaSchema.safeParse(notification.data.params)
        if (delta.success) {
          this.dispatchEvent(new CustomEvent("workspace-delta", { detail: delta.data }))
        }
        return
      }
      if (notification.data.method === "system.emergencyStopped") {
        const stopped = systemEmergencyStoppedNotificationSchema.safeParse(
          notification.data.params,
        )
        if (stopped.success) {
          this.dispatchEvent(new CustomEvent("emergency-stopped", { detail: stopped.data }))
        }
        return
      }
      if (notification.data.method === "terminal.output") {
        const output = terminalOutputNotificationSchema.safeParse(notification.data.params)
        if (output.success) {
          this.dispatchEvent(new CustomEvent("terminal-output", { detail: output.data }))
        }
        return
      }
      if (notification.data.method === "terminal.closed") {
        const closed = terminalClosedNotificationSchema.safeParse(notification.data.params)
        if (closed.success) {
          this.dispatchEvent(new CustomEvent("terminal-closed", { detail: closed.data }))
        }
        return
      }
      if (notification.data.method === "terminal.ownership") {
        const ownership = terminalOwnershipNotificationSchema.safeParse(notification.data.params)
        if (ownership.success) {
          this.dispatchEvent(new CustomEvent("terminal-ownership", { detail: ownership.data }))
        }
        return
      }
    }

    const response = rpcResponseSchema.safeParse(input)
    if (!response.success || typeof response.data.id !== "number") return
    const pending = this.#pending.get(response.data.id)
    if (!pending) return
    this.#pending.delete(response.data.id)
    pending.cleanup()

    if (response.data.error) {
      const error = new DaemonRpcError(response.data.error.code, response.data.error.message)
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
