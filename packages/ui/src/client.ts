import {
  rpcNotificationSchema,
  rpcResponseSchema,
  providerModelsSchema,
  workspaceSnapshotSchema,
  type ClientKind,
  type ApprovalDecision,
  type Annotation,
  type ProviderModel,
  type RpcMethod,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

type PendingRequest = {
  parse: (value: unknown) => unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type DomovoiClientOptions = {
  reconnectDelayMs?: number
}

export class DomovoiClient extends EventTarget {
  readonly url: string
  readonly kind: ClientKind
  #socket: WebSocket | undefined
  #requestId = 0
  #pending = new Map<number, PendingRequest>()
  #opening: Promise<WorkspaceSnapshot> | undefined
  #reconnectDelayMs: number
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #shouldReconnect = false

  constructor(url: string, kind: ClientKind, options: DomovoiClientOptions = {}) {
    super()
    this.url = url
    this.kind = kind
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000
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
          this.request("system.hello", { client: this.kind, clientVersion: "0.0.1" }).then(
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

  request(method: RpcMethod, params: unknown): Promise<WorkspaceSnapshot>
  request<T>(method: RpcMethod, params: unknown, parse: (value: unknown) => T): Promise<T>
  request<T = WorkspaceSnapshot>(
    method: RpcMethod,
    params: unknown,
    parse: (value: unknown) => T = (value) => workspaceSnapshotSchema.parse(value) as T,
  ): Promise<T> {
    const id = ++this.#requestId
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Daemon connection is not open"))
        return
      }
      this.#pending.set(id, {
        parse,
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

  listModels(provider: "codex"): Promise<ProviderModel[]> {
    return this.request(
      "runtime.models",
      { provider, client: this.kind },
      (value) => providerModelsSchema.parse(value),
    )
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
    if (notification.success && notification.data.method === "workspace.changed") {
      const snapshot = workspaceSnapshotSchema.safeParse(notification.data.params)
      if (snapshot.success) {
        this.dispatchEvent(new CustomEvent("snapshot", { detail: snapshot.data }))
      }
      return
    }

    const response = rpcResponseSchema.safeParse(input)
    if (!response.success || typeof response.data.id !== "number") return
    const pending = this.#pending.get(response.data.id)
    if (!pending) return
    this.#pending.delete(response.data.id)

    if (response.data.error) {
      pending.reject(new Error(response.data.error.message))
      return
    }

    try {
      pending.resolve(pending.parse(response.data.result))
    } catch {
      pending.reject(new Error("Daemon returned an invalid RPC result"))
    }
  }
}
