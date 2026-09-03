import {
  demoWorkspace,
  rpcMethods,
  rpcRequestSchema,
  type RpcMethod,
  type RpcRequest,
  type RpcResult,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

export type FakeWebSocketClose = {
  code: number | undefined
  reason: string | undefined
}

export type FakeRpcError = {
  code: number
  message: string
  data?: unknown
}

let registry: FakeWebSocket[] | undefined

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED
  readonly sent: RpcRequest[] = []
  readonly answered = new Set<RpcRequest["id"]>()
  readonly closeCalls: FakeWebSocketClose[] = []
  readyState: number = FakeWebSocket.CONNECTING
  binaryType: BinaryType = "blob"

  constructor(readonly url: string) {
    super()
    if (!registry) throw new Error("FakeWebSocket is not installed; call installFakeWebSocket() first")
    registry.push(this)
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`FakeWebSocket ${this.url} is not open`)
    }
    this.sent.push(rpcRequestSchema.parse(JSON.parse(data)))
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
    this.#dispatchClose(code ?? 1000, reason ?? "")
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.#dispatchClose(code, reason)
  }

  #dispatchClose(code: number, reason: string): void {
    const event = new Event("close")
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    })
    this.dispatchEvent(event)
  }
}

export type FakeWebSocketHarness = {
  readonly sockets: readonly FakeWebSocket[]
  socket(index: number): FakeWebSocket
  uninstall(): void
}

export function installFakeWebSocket(): FakeWebSocketHarness {
  const sockets: FakeWebSocket[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  registry = sockets
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  })
  return {
    sockets,
    socket(index) {
      const socket = sockets[index]
      if (!socket) throw new Error(`No fake WebSocket #${index} (created ${sockets.length})`)
      return socket
    },
    uninstall() {
      if (registry === sockets) registry = undefined
      if (previous) Object.defineProperty(globalThis, "WebSocket", previous)
      else delete (globalThis as { WebSocket?: unknown }).WebSocket
    },
  }
}

export function sentRequests(socket: FakeWebSocket, method?: RpcMethod): RpcRequest[] {
  return method ? socket.sent.filter((request) => request.method === method) : [...socket.sent]
}

export function pendingRequest(socket: FakeWebSocket, method: RpcMethod): RpcRequest {
  const request = socket.sent.find(
    (candidate) => candidate.method === method && !socket.answered.has(candidate.id),
  )
  if (!request) throw new Error(`No pending ${method} request on ${socket.url}`)
  return request
}

export function respond<M extends RpcMethod>(
  socket: FakeWebSocket,
  method: M,
  result: RpcResult<M>,
): RpcRequest {
  const request = pendingRequest(socket, method)
  socket.answered.add(request.id)
  socket.receive({ jsonrpc: "2.0", id: request.id, result: rpcMethods[method].result.parse(result) })
  return request
}

export function fail(socket: FakeWebSocket, method: RpcMethod, error: FakeRpcError): RpcRequest {
  const request = pendingRequest(socket, method)
  socket.answered.add(request.id)
  socket.receive({ jsonrpc: "2.0", id: request.id, error })
  return request
}

export function notify(socket: FakeWebSocket, method: string, params: unknown): void {
  socket.receive({ jsonrpc: "2.0", method, params })
}

export function workspaceSnapshot(
  overrides: Partial<WorkspaceSnapshot> = {},
): RpcResult<"system.hello"> {
  return rpcMethods["system.hello"].result.parse({
    ...structuredClone(demoWorkspace),
    ...overrides,
  })
}

export function completeHandshake(
  socket: FakeWebSocket,
  snapshot: RpcResult<"system.hello"> = workspaceSnapshot(),
): RpcRequest {
  socket.open()
  return respond(socket, "system.hello", snapshot)
}
