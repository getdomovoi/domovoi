import {
  applyWorkspaceDelta,
  workspaceDeltaSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { clientVersion, protocolVersionForClient } from "./protocol-facts"

type Pending = { resolve: (value: unknown) => void, reject: (error: Error) => void }

export type DaemonStatus = "connecting" | "open" | "closed"

// The phone connects to a daemon over the tailnet like any other client. This
// is a small client rather than the desktop one, which is bound to browser APIs
// the runtime does not have.
export class DaemonConnection {
  #socket: WebSocket | undefined
  #pending = new Map<number, Pending>()
  #nextId = 1
  #closed = false

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: {
      onSnapshot: (snapshot: WorkspaceSnapshot) => void
      onDelta: (delta: Parameters<typeof applyWorkspaceDelta>[1]) => void
      onStatus: (status: DaemonStatus) => void
      onError: (message: string) => void
      onClosed: () => void
    },
  ) {}

  connect(): void {
    this.#closed = false
    this.handlers.onStatus("connecting")
    const socket = new WebSocket(this.url)
    this.#socket = socket

    socket.onopen = () => {
      void this.call("system.hello", {
        client: "phone",
        clientId: `phone-${Math.random().toString(16).slice(2, 10)}`,
        clientVersion,
        protocolVersion: protocolVersionForClient,
        authToken: this.token,
      }).then(
        (snapshot) => {
          this.handlers.onStatus("open")
          this.handlers.onSnapshot(snapshot as WorkspaceSnapshot)
        },
        (cause: Error) => {
          this.handlers.onError(cause.message)
          this.close()
        },
      )
    }

    socket.onmessage = (event) => {
      let message: {
        id?: number
        result?: unknown
        error?: { message?: string }
        method?: string
        params?: unknown
      }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? "The daemon refused"))
        else pending.resolve(message.result)
        return
      }
      // A delta describes a change to the snapshot the client already holds, so
      // it is applied rather than treated as a reason to ask for everything.
      if (message.method === "workspace.delta") {
        const parsed = workspaceDeltaSchema.safeParse(message.params)
        if (parsed.success) this.handlers.onDelta(parsed.data)
      }
    }

    socket.onerror = () => {
      if (!this.#closed) this.handlers.onError(`Cannot reach ${this.url}`)
    }

    socket.onclose = () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("The daemon closed the connection"))
      }
      this.#pending.clear()
      this.handlers.onStatus("closed")
      if (!this.#closed) this.handlers.onClosed()
    }
  }

  isOpen(): boolean {
    return this.#socket?.readyState === 1
  }

  call(method: string, params: unknown): Promise<unknown> {
    const socket = this.#socket
    if (!socket) return Promise.reject(new Error("The daemon connection is not open"))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }

  close(): void {
    this.#closed = true
    this.#socket?.close()
    this.#socket = undefined
  }
}
