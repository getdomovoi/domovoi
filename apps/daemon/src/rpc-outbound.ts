import { Buffer } from "node:buffer"

export const rpcWebSocketHighWaterBytes = 1_024 * 1_024
export const rpcWebSocketLowWaterBytes = 256 * 1_024
export const rpcWebSocketBackpressurePollMilliseconds = 16
export const maximumRpcWebSocketBackpressurePolls = 64
export const retryableSlowClientCloseCode = 1013
export const retryableSlowClientCloseReason = "client too slow; retry"

type Timer = unknown
type Schedule = (callback: () => void, delayMilliseconds: number) => Timer
type Cancel = (timer: Timer) => void

const scheduleTimeout: Schedule = (callback, delay) => setTimeout(callback, delay)
const cancelTimeout: Cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)

export type RpcOutboundSocket = {
  readonly bufferedAmount: number
  readonly readyState: number
  send(message: string): void
  close(code: number, reason: string): void
}

type PendingResync = {
  message: () => string
  timer: Timer
  pollsRemaining: number
}

export type RpcOutboundBackpressureOptions = {
  highWaterBytes?: number
  lowWaterBytes?: number
  pollMilliseconds?: number
  maximumPolls?: number
  schedule?: Schedule
  cancel?: Cancel
  bufferedBytes?: (socket: RpcOutboundSocket) => number
}

const openSocketState = 1
const coalescibleWorkspaceNotifications = new Set([
  "workspace.changed",
  "workspace.delta",
])
const terminalNotifications = new Set([
  "terminal.output",
  "terminal.closed",
  "terminal.ownership",
])

/**
 * Bounds ordinary RPC output without taking ownership of terminal notifications.
 * Only one payload-free resync marker and one timer may be retained per client.
 */
export class RpcOutboundBackpressure {
  readonly #highWaterBytes: number
  readonly #lowWaterBytes: number
  readonly #pollMilliseconds: number
  readonly #maximumPolls: number
  readonly #schedule: Schedule
  readonly #cancel: Cancel
  readonly #bufferedBytes: (socket: RpcOutboundSocket) => number
  readonly #pendingResyncs = new Map<RpcOutboundSocket, PendingResync>()

  constructor(options: RpcOutboundBackpressureOptions = {}) {
    this.#highWaterBytes = options.highWaterBytes ?? rpcWebSocketHighWaterBytes
    this.#lowWaterBytes = options.lowWaterBytes ?? rpcWebSocketLowWaterBytes
    this.#pollMilliseconds = options.pollMilliseconds ?? rpcWebSocketBackpressurePollMilliseconds
    this.#maximumPolls = options.maximumPolls ?? maximumRpcWebSocketBackpressurePolls
    this.#schedule = options.schedule ?? scheduleTimeout
    this.#cancel = options.cancel ?? cancelTimeout
    this.#bufferedBytes = options.bufferedBytes ?? ((socket) => socket.bufferedAmount)
    if (
      this.#lowWaterBytes < 0
      || this.#highWaterBytes <= 0
      || this.#lowWaterBytes >= this.#highWaterBytes
      || !Number.isInteger(this.#maximumPolls)
      || this.#maximumPolls <= 0
    ) {
      throw new Error("Invalid RPC WebSocket backpressure bounds")
    }
  }

  get retainedClientCount(): number {
    return this.#pendingResyncs.size
  }

  send(socket: RpcOutboundSocket, message: string): boolean {
    if (socket.readyState !== openSocketState) {
      this.forget(socket)
      return false
    }
    if (this.#wouldReachHighWater(socket, message)) {
      this.#closeSlowClient(socket)
      return false
    }
    socket.send(message)
    return true
  }

  notify(
    socket: RpcOutboundSocket,
    method: string,
    message: string,
    resyncMessage: () => string,
  ): boolean {
    if (terminalNotifications.has(method)) {
      if (socket.readyState !== openSocketState) return false
      socket.send(message)
      return true
    }
    if (!coalescibleWorkspaceNotifications.has(method)) return this.send(socket, message)
    if (
      this.#pendingResyncs.has(socket)
      || this.#wouldReachHighWater(socket, message)
    ) {
      this.#retainResync(socket, resyncMessage)
      return false
    }
    return this.send(socket, message)
  }

  forget(socket: RpcOutboundSocket): void {
    const pending = this.#pendingResyncs.get(socket)
    if (pending) this.#cancel(pending.timer)
    this.#pendingResyncs.delete(socket)
  }

  dispose(): void {
    for (const socket of [...this.#pendingResyncs.keys()]) this.forget(socket)
  }

  #retainResync(socket: RpcOutboundSocket, message: () => string): void {
    const existing = this.#pendingResyncs.get(socket)
    if (existing) {
      existing.message = message
      return
    }
    const timer = this.#schedule(
      () => this.#checkResync(socket),
      this.#pollMilliseconds,
    )
    this.#pendingResyncs.set(socket, {
      message,
      timer,
      pollsRemaining: this.#maximumPolls,
    })
  }

  #checkResync(socket: RpcOutboundSocket): void {
    const pending = this.#pendingResyncs.get(socket)
    if (!pending) return
    if (socket.readyState !== openSocketState) {
      this.#pendingResyncs.delete(socket)
      return
    }
    if (this.#bufferedBytes(socket) <= this.#lowWaterBytes) {
      this.#pendingResyncs.delete(socket)
      this.send(socket, pending.message())
      return
    }
    if (pending.pollsRemaining <= 1) {
      this.#closeSlowClient(socket)
      return
    }
    pending.pollsRemaining -= 1
    pending.timer = this.#schedule(
      () => this.#checkResync(socket),
      this.#pollMilliseconds,
    )
  }

  #closeSlowClient(socket: RpcOutboundSocket): void {
    this.forget(socket)
    socket.close(retryableSlowClientCloseCode, retryableSlowClientCloseReason)
  }

  #wouldReachHighWater(socket: RpcOutboundSocket, message: string): boolean {
    return this.#bufferedBytes(socket) + Buffer.byteLength(message, "utf8")
      >= this.#highWaterBytes
  }
}
