import {
  applyWorkspaceDelta,
  workspaceDeltaSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { clientKind, clientVersion, protocolVersionForClient } from "./protocol-facts"

type Pending = { resolve: (value: unknown) => void, reject: (error: Error) => void }

// A refusal can carry structured data saying what the daemon objected to, and a
// plain Error throws it away. The turn skill refusal is read out of this, so
// the phone can name the skill rather than show the sentence and guess. The
// code is what separates a refusal that will never change from one worth
// retrying, and it is the daemon's own constant rather than its wording.
export class DaemonError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly data: unknown) {
    super(message)
    this.name = "DaemonError"
  }
}

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
      // The cause rather than its sentence, because whether a refusal is worth
      // retrying is decided by the daemon's error code, not its wording.
      onError: (cause: unknown) => void
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
        client: clientKind,
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
          this.handlers.onError(cause)
          this.close()
        },
      )
    }

    socket.onmessage = (event) => {
      let message: {
        id?: number
        result?: unknown
        error?: { code?: number, message?: string, data?: unknown }
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
        if (message.error) {
          pending.reject(new DaemonError(
            message.error.message ?? "The daemon refused",
            message.error.code,
            message.error.data,
          ))
        } else {
          pending.resolve(message.result)
        }
        return
      }
      // A delta describes a change to the snapshot the client already holds, so
      // it is applied rather than treated as a reason to ask for everything.
      if (message.method === "workspace.delta") {
        const parsed = workspaceDeltaSchema.safeParse(message.params)
        if (parsed.success) this.handlers.onDelta(parsed.data)
        return
      }
      // Everything except streamed provider output arrives as a whole snapshot,
      // so a phone that only listened for deltas showed the state it connected
      // with and never the result of its own decisions.
      if (message.method === "workspace.changed") {
        const parsed = workspaceSnapshotSchema.safeParse(message.params)
        if (parsed.success) this.handlers.onSnapshot(parsed.data)
      }
    }

    socket.onerror = () => {
      if (!this.#closed) this.handlers.onError(new Error(`Cannot reach ${this.url}`))
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

  // Requests sent and not yet answered. Every one of them holds a promise the
  // caller is waiting on, so a number that climbs and never falls is the shape
  // of a leak.
  pendingRequests(): number {
    return this.#pending.size
  }

  call(method: string, params: unknown): Promise<unknown> {
    const socket = this.#socket
    if (!socket) return Promise.reject(new Error("The daemon connection is not open"))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (cause) {
        // Sending on a socket that is already closing throws, and the entry
        // would otherwise sit in the map waiting for a reply to a request that
        // was never sent. It is cleared here rather than left for onclose,
        // because depending on another handler to tidy up is a promise this
        // class cannot keep on its own.
        this.#pending.delete(id)
        reject(cause instanceof Error ? cause : new Error("The request could not be sent"))
      }
    })
  }

  close(): void {
    this.#closed = true
    this.#socket?.close()
    this.#socket = undefined
  }
}
