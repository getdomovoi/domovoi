import { rpcResponseSchema, type ClientKind, type RpcParams } from "@getdomovoi/protocol"

import { DaemonRpcError, DomovoiClient } from "./client.js"

const pairingBudgetMs = 30_000
const redeemRequestId = 1

type Waiting = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// The socket failed, closed or timed out before the daemon answered, so it is
// not known whether the code was spent. Only this failure lets the page send
// the same code again; a refusal, a misuse or an unreadable reply does not.
export class PairingTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingTransportError"
  }
}

// The daemon answered the code, but not with anything this page can read: a
// malformed envelope for the request, or a result that is not a device and
// credential. It may have spent the code and paired the browser, so this is
// never retried.
export class PairingReplyError extends Error {
  constructor() {
    super("The daemon's reply to the code could not be read")
    this.name = "PairingReplyError"
  }
}

// A tab that holds no credential cannot greet the daemon: it refuses a
// system.hello without one, and DomovoiClient greets before anything else, so a
// code sent through it never arrives. Spending a code is the one call the
// daemon answers on a socket that has not greeted, inside its authentication
// deadline. This client opens the socket, sends that call alone, and closes.
// The phone app does the same in apps/mobile/src/lib/redeem-pairing-code.ts.
export class CodeRedemptionClient {
  readonly #url: string
  readonly #budgetMs: number
  #socket: WebSocket | undefined
  #listeners: AbortController | undefined
  #waiting: Waiting | undefined
  #sent = false

  constructor(url: string, budgetMs: number) {
    this.#url = url
    this.#budgetMs = budgetMs
  }

  // Resolves once the socket is open. Nothing is sent until request.
  connect(): Promise<unknown> {
    if (this.#socket) return Promise.reject(new Error("A code redemption client opens one connection"))
    const listeners = new AbortController()
    this.#listeners = listeners
    return this.#wait(`Daemon did not open a connection within ${this.#budgetMs} ms`, () => {
      const socket = new WebSocket(this.#url)
      this.#socket = socket
      const { signal } = listeners
      socket.addEventListener("open", () => this.#settle({ value: undefined }), { signal })
      socket.addEventListener("message", (event) => this.#receive(event.data), { signal })
      socket.addEventListener("error", () => this.#settle({ error: new PairingTransportError("Daemon connection failed") }), { signal })
      socket.addEventListener("close", () => this.#settle({ error: new PairingTransportError("Daemon connection closed") }), { signal })
    })
  }

  request(method: "device.redeemCode", params: RpcParams<"device.redeemCode">): Promise<unknown> {
    const socket = this.#socket
    // A second call on this client is a misuse, not a dropped connection.
    if (this.#sent) return Promise.reject(new Error("A code redemption client sends one code"))
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new PairingTransportError("Daemon connection closed"))
    }
    return this.#wait(`Daemon did not answer ${method} within ${this.#budgetMs} ms`, () => {
      this.#sent = true
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: redeemRequestId, method, params }))
    })
  }

  disconnect(): void {
    this.#settle({ error: new PairingTransportError("Daemon connection closed") })
    this.#listeners?.abort()
    this.#socket?.close(1000, "client closed")
  }

  #wait(timeoutMessage: string, start: () => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#settle({ error: new PairingTransportError(timeoutMessage) }), this.#budgetMs)
      this.#waiting = { resolve, reject, timer }
      try { start() } catch (cause) {
        this.#settle({ error: new PairingTransportError(cause instanceof Error ? cause.message : "Daemon socket could not be created") })
      }
    })
  }

  #settle(outcome: { value: unknown } | { error: Error }): void {
    const waiting = this.#waiting
    this.#waiting = undefined
    if (!waiting) return
    clearTimeout(waiting.timer)
    if ("error" in outcome) waiting.reject(outcome.error)
    else waiting.resolve(outcome.value)
  }

  // Only the reply to the one request counts. Anything else on this socket is
  // left for the deadline, which the page reports as no answer. A frame that
  // carries the request's id is the daemon's answer even when its envelope is
  // malformed, so it settles as an unreadable reply, not as a timeout. A frame
  // that is not JSON cannot be tied to the request and is left alone.
  #receive(data: unknown): void {
    if (!this.#sent || typeof data !== "string") return
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return }
    const reply = rpcResponseSchema.safeParse(parsed)
    if (!reply.success) {
      const id = typeof parsed === "object" && parsed !== null ? (parsed as { id?: unknown }).id : undefined
      if (id === redeemRequestId) this.#settle({ error: new PairingReplyError() })
      return
    }
    if (reply.data.id !== redeemRequestId) return
    if (reply.data.error) {
      const { code, message, data: detail } = reply.data.error
      this.#settle({ error: new DaemonRpcError(code, message, detail) })
      return
    }
    this.#settle({ value: reply.data.result })
  }
}

// The client the browser connect page pairs with. A bearer pairs through a
// greeting, as every authenticated client does; a code is sent before any.
export function createBrowserPairingClient(input: { url: string; client: ClientKind; bearer: string }): DomovoiClient
export function createBrowserPairingClient(input: { url: string; client: ClientKind; bearer?: never }): CodeRedemptionClient
export function createBrowserPairingClient(input: { url: string; client: ClientKind; bearer?: string }): DomovoiClient | CodeRedemptionClient {
  if (input.bearer === undefined) return new CodeRedemptionClient(input.url, pairingBudgetMs)
  return new DomovoiClient(input.url, input.client, {
    budgets: { connectMs: pairingBudgetMs, requestMs: pairingBudgetMs },
    authToken: input.bearer,
  })
}
