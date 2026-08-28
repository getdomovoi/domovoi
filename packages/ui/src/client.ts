import {
  daemonAuthenticationErrorCode,
  rpcNotificationSchema,
  rpcMethods,
  rpcResponseSchema,
  artifactAuthorizeResultSchema,
  terminalAcceptedSchema,
  terminalClosedNotificationSchema,
  terminalOwnershipNotificationSchema,
  terminalOutputNotificationSchema,
  terminalSessionSchema,
  workspaceSnapshotSchema,
  type ClientKind,
  type ApprovalDecision,
  type Annotation,
  type ArtifactAccess,
  type ProviderModel,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Runtime,
  type SkillSummary,
  type TerminalSession,
  type TerminalOwnershipNotification,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

class DaemonRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "DaemonRpcError"
    this.code = code
  }
}

type PendingRequest = {
  parse: (value: unknown) => unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type DomovoiClientOptions = {
  reconnectDelayMs?: number
  authToken?: string
  clientId?: string
}

export class DomovoiClient extends EventTarget {
  readonly url: string
  readonly kind: ClientKind
  readonly clientId: string
  #socket: WebSocket | undefined
  #requestId = 0
  #pending = new Map<number, PendingRequest>()
  #opening: Promise<WorkspaceSnapshot> | undefined
  #reconnectDelayMs: number
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #shouldReconnect = false
  #authToken: string | undefined

  constructor(url: string, kind: ClientKind, options: DomovoiClientOptions = {}) {
    super()
    this.url = url
    this.kind = kind
    this.clientId = options.clientId ?? crypto.randomUUID()
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000
    this.#authToken = options.authToken
  }

  connect(): Promise<WorkspaceSnapshot> {
    this.#shouldReconnect = true
    this.#clearReconnectTimer()
    return this.#open()
  }

  #open(): Promise<WorkspaceSnapshot> {
    if (this.#opening) return this.#opening
    if (this.#socket) return Promise.reject(new Error("Daemon connection is already open"))

    const opening = new Promise<WorkspaceSnapshot>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.#socket = socket
      let opening = true
      const rejectOpening = (error: Error) => {
        if (!opening) return
        opening = false
        reject(error)
      }
      socket.addEventListener("error", () => {
        rejectOpening(new Error(`Cannot reach ${this.url}`))
        socket.close()
      }, { once: true })
      socket.addEventListener(
        "open",
        () => {
          this.request("system.hello", {
            client: this.kind,
            clientVersion: "0.0.1",
            ...(this.#authToken ? { authToken: this.#authToken } : {}),
          }).then(
            (snapshot) => {
              if (socket !== this.#socket) return
              opening = false
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
        if (socket === this.#socket) this.#receive(String(event.data))
      })
      socket.addEventListener("close", () => {
        if (socket !== this.#socket) return
        this.#socket = undefined
        const error = new Error("Daemon connection closed")
        rejectOpening(error)
        this.#rejectPending(error)
        this.dispatchEvent(new Event("disconnected"))
        this.#scheduleReconnect()
      })
    })
    this.#opening = opening
    void opening.then(
      () => {
        if (this.#opening === opening) this.#opening = undefined
      },
      () => {
        if (this.#opening === opening) this.#opening = undefined
      },
    )
    return opening
  }

  disconnect(): void {
    this.#shouldReconnect = false
    this.#clearReconnectTimer()
    const socket = this.#socket
    this.#rejectPending(new Error("Daemon connection closed"))
    socket?.close(1000, "client closed")
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  request<M extends RpcMethod, T>(
    method: M,
    params: RpcParams<M>,
    parse: (value: unknown) => T,
  ): Promise<T>
  request<M extends RpcMethod, T>(
    method: M,
    params: RpcParams<M>,
    parse?: (value: unknown) => T,
  ): Promise<T> {
    const id = ++this.#requestId
    const resultParser = parse ?? ((value: unknown) => rpcMethods[method].result.parse(value) as T)
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Daemon connection is not open"))
        return
      }
      this.#pending.set(id, {
        parse: resultParser,
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
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
      client: this.kind,
      ...(explanation ? { explanation } : {}),
    })
  }

  setRuntime(sessionId: string, runtime: Runtime): Promise<WorkspaceSnapshot> {
    return this.request("session.setRuntime", { sessionId, runtime, client: this.kind })
  }

  activateSession(sessionId: string): Promise<WorkspaceSnapshot> {
    return this.request("session.activate", { sessionId, client: this.kind })
  }

  openProject(path: string): Promise<WorkspaceSnapshot> {
    return this.request("project.open", { path, client: this.kind })
  }

  createSession(title: string, runtime: Runtime): Promise<WorkspaceSnapshot> {
    return this.request("session.create", { title, runtime, client: this.kind })
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

  pauseAll(): Promise<WorkspaceSnapshot> {
    return this.request("system.pauseAll", { client: this.kind })
  }

  pauseSession(sessionId: string): Promise<WorkspaceSnapshot> {
    return this.request("session.pause", { sessionId, client: this.kind })
  }

  authorizeArtifact(artifactId: string, bridgeChannel?: string): Promise<ArtifactAccess> {
    return this.request(
      "artifact.authorize",
      {
        artifactId,
        ...(bridgeChannel ? { bridgeChannel } : {}),
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

  listSkills(): Promise<SkillSummary[]> {
    return this.request("skill.list", {})
  }

  #scheduleReconnect(): void {
    if (!this.#shouldReconnect || this.#reconnectTimer) return
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.#open().catch(() => undefined)
    }, this.#reconnectDelayMs)
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
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

    if (response.data.error) {
      if (response.data.error.code === daemonAuthenticationErrorCode) {
        this.#shouldReconnect = false
        this.#clearReconnectTimer()
      }
      pending.reject(new DaemonRpcError(response.data.error.code, response.data.error.message))
      return
    }

    try {
      pending.resolve(pending.parse(response.data.result))
    } catch (cause) {
      pending.reject(new Error("Daemon returned an invalid RPC result", { cause }))
    }
  }
}
