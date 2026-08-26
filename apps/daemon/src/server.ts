import { createServer, type Server as HttpServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  demoWorkspace,
  protocolVersion,
  rpcMethods,
  rpcRequestSchema,
  workspaceSnapshotSchema,
  type RpcMethod,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from "ws"

import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"

const invalidRequest = -32600
const methodNotFound = -32601
const invalidParams = -32602
const internalError = -32603

export type DaemonServerOptions = {
  host?: string
  port?: number
  allowedOrigins?: string[]
  statePath?: string
  store?: WorkspaceStore
}

export class DomovoiDaemon {
  readonly host: string
  readonly requestedPort: number
  readonly allowedOrigins: ReadonlySet<string>
  #http: HttpServer | undefined
  #websocket: WebSocketServer | undefined
  #snapshot: WorkspaceSnapshot
  #store: WorkspaceStore

  constructor(options: DaemonServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
    this.requestedPort = options.port ?? 47831
    this.allowedOrigins = new Set(
      options.allowedOrigins ?? ["http://127.0.0.1:5178", "http://localhost:5178", "file://"],
    )
    this.#store = options.store ?? new SqliteWorkspaceStore(
      options.statePath ?? join(homedir(), ".domovoi", "state.sqlite"),
      workspaceSnapshotSchema.parse(structuredClone(demoWorkspace)),
    )
    this.#snapshot = this.#store.load()
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.#http?.address()
    if (!address || typeof address === "string") return undefined
    return { host: this.host, port: address.port }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.#http) throw new Error("Daemon is already running")

    this.#http = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "ok", protocolVersion }))
        return
      }

      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
    })

    const verifyClient: VerifyClientCallbackSync = ({ origin }) =>
      !origin || this.allowedOrigins.has(origin)

    this.#websocket = new WebSocketServer({
      server: this.#http,
      path: "/rpc",
      verifyClient,
    })
    this.#websocket.on("connection", (socket) => {
      socket.on("message", (data) => this.#handle(socket, data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      this.#http!.once("error", reject)
      this.#http!.listen(this.requestedPort, this.host, () => resolve())
    })

    return this.address!
  }

  async stop(): Promise<void> {
    for (const client of this.#websocket?.clients ?? []) client.close(1001, "daemon stopping")

    await new Promise<void>((resolve, reject) => {
      if (!this.#http) return resolve()
      this.#http.close((error) => (error ? reject(error) : resolve()))
    })

    this.#websocket = undefined
    this.#http = undefined
    this.#store.close()
  }

  #send(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload))
  }

  #broadcastSnapshot(): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: this.#snapshot,
    })

    for (const client of this.#websocket?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(message)
    }
  }

  #error(socket: WebSocket, id: string | number | null, code: number, message: string): void {
    this.#send(socket, { jsonrpc: "2.0", id, error: { code, message } })
  }

  #handle(socket: WebSocket, raw: string): void {
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      this.#error(socket, null, invalidRequest, "Request is not valid JSON")
      return
    }

    const requestResult = rpcRequestSchema.safeParse(input)
    if (!requestResult.success) {
      this.#error(socket, null, invalidRequest, "Request does not match JSON-RPC 2.0")
      return
    }

    const request = requestResult.data
    if (!(request.method in rpcMethods)) {
      this.#error(socket, request.id, methodNotFound, `Unknown method: ${request.method}`)
      return
    }

    const method = request.method as RpcMethod
    const paramsResult = rpcMethods[method].params.safeParse(request.params ?? {})
    if (!paramsResult.success) {
      this.#error(socket, request.id, invalidParams, "Method parameters are invalid")
      return
    }

    try {
      if (method === "approval.resolve") {
        const params = rpcMethods[method].params.parse(request.params)
        const approval = this.#snapshot.approvals.find(
          (candidate) => candidate.id === params.approvalId,
        )
        if (!approval) {
          this.#error(socket, request.id, invalidParams, "Approval does not exist")
          return
        }
        if (params.decision === "always-project") {
          this.#snapshot.approvalRules.push({
            id: `rule-${approval.id}-${Date.now()}`,
            projectId: this.#snapshot.project.id,
            operation: approval.operation,
            command: approval.command,
            createdBy: params.client,
            createdAt: new Date().toISOString(),
          })
        }
        this.#snapshot.thread.push({
          id: `receipt-${approval.id}-${Date.now()}`,
          kind: "receipt",
          decision: params.decision,
          operation: approval.operation,
          checkpoint: approval.checkpoint,
          client: params.client,
          ...(params.explanation ? { explanation: params.explanation } : {}),
          createdAt: new Date().toISOString(),
        })
        this.#snapshot.approvals = this.#snapshot.approvals.filter(
          (approval) => approval.id !== params.approvalId,
        )
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === this.#snapshot.activeSessionId,
        )
        if (session) {
          session.state = params.decision === "deny" || params.decision === "deny-explain"
            ? "idle"
            : "active"
        }
      }

      if (method === "session.setRuntime") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        session.runtime = params.runtime
      }

      this.#snapshot = workspaceSnapshotSchema.parse(this.#snapshot)
      if (method === "approval.resolve" || method === "session.setRuntime") {
        this.#store.save(this.#snapshot)
      }
      this.#send(socket, { jsonrpc: "2.0", id: request.id, result: this.#snapshot })

      if (method === "approval.resolve" || method === "session.setRuntime") {
        this.#broadcastSnapshot()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown daemon error"
      this.#error(socket, request.id, internalError, message)
    }
  }
}
