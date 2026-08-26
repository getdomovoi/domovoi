import {
  demoWorkspace,
  rpcNotificationSchema,
  rpcResponseSchema,
  workspaceSnapshotSchema,
  type ClientKind,
  type ApprovalDecision,
  type RpcMethod,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

type PendingRequest = {
  resolve: (value: WorkspaceSnapshot) => void
  reject: (error: Error) => void
}

export class DomovoiClient extends EventTarget {
  readonly url: string
  readonly kind: ClientKind
  #socket: WebSocket | undefined
  #requestId = 0
  #pending = new Map<number, PendingRequest>()

  constructor(url: string, kind: ClientKind) {
    super()
    this.url = url
    this.kind = kind
  }

  connect(): Promise<WorkspaceSnapshot> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.#socket = socket
      socket.addEventListener("error", () => reject(new Error(`Cannot reach ${this.url}`)), {
        once: true,
      })
      socket.addEventListener(
        "open",
        () => {
          this.request("system.hello", { client: this.kind, clientVersion: "0.0.1" }).then(
            resolve,
            reject,
          )
        },
        { once: true },
      )
      socket.addEventListener("message", (event) => this.#receive(String(event.data)))
      socket.addEventListener("close", () => this.dispatchEvent(new Event("disconnected")))
    })
  }

  disconnect(): void {
    this.#socket?.close(1000, "client closed")
    this.#socket = undefined
  }

  request(method: RpcMethod, params: unknown): Promise<WorkspaceSnapshot> {
    const id = ++this.#requestId
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Daemon connection is not open"))
        return
      }
      this.#pending.set(id, { resolve, reject })
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

    const snapshot = workspaceSnapshotSchema.safeParse(response.data.result)
    if (snapshot.success) pending.resolve(snapshot.data)
    else pending.reject(new Error("Daemon returned an invalid workspace snapshot"))
  }
}

export function getDemoWorkspace(): WorkspaceSnapshot {
  return workspaceSnapshotSchema.parse(structuredClone(demoWorkspace))
}
