import { WebSocket } from "ws"
import type { z } from "zod"

import { buildVersion, maximumRpcMessageBytes, protocolVersion, rpcResponseSchema } from "@getdomovoi/protocol"

import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

// A one-shot CLI command spends one budget across connect, hello and the call
// itself. Pairing is the first command a new machine runs, often against a
// hand-typed address, so a listener that accepts the socket and then says
// nothing has to be refused on the same allowance as one that never accepts it.
export const defaultCliCommandTimeoutMs = 15_000

// A refusal written by this CLI: it names the address, the wait that expired
// and the remedy, and it quotes nothing the daemon sent. Commands may repeat
// it verbatim, unlike an arbitrary daemon error.
export class CliDeadlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliDeadlineError"
  }
}

export type CliRpcTarget = {
  host: string
  port: number
  tls?: unknown
}

const helloRequestId = 1
const callRequestId = 2

function endpointUrl(target: CliRpcTarget): string {
  return `${target.tls ? "wss" : "ws"}://${target.host}:${target.port}/rpc`
}

// The refusal is read off a terminal, so the address it repeats carries only
// what a host and port can hold. The bearer token travels in a header and is
// never part of this text.
function describedAddress(target: CliRpcTarget): string {
  const host = target.host.replace(/[^A-Za-z0-9.:_[\]-]/g, "").slice(0, 128)
  const port = Number.isSafeInteger(target.port) && target.port > 0 && target.port <= 65_535 ? target.port : 0
  return `${target.tls ? "wss" : "ws"}://${host}:${port}/rpc`
}

function refusal(deadline: OperationDeadline, address: string, waitedOn: string): Error {
  if (!(deadline.signal.reason instanceof OperationDeadlineExceededError)) {
    return new Error("The domovoid command was cancelled")
  }
  return new CliDeadlineError(`The daemon at ${address} did not ${waitedOn} before the deadline.`
    + " Check that domovoid is running at that address, then run this command again.")
}

// Every wait shares the caller's deadline: a phase cannot buy a fresh
// allowance after an earlier phase has spent the budget.
function bounded<T>(
  deadline: OperationDeadline,
  address: string,
  waitedOn: string,
  start: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try { deadline.throwIfExpired() } catch (error) { reject(error as Error); return }
    // The wait can settle inside start, before start has returned the function
    // that removes its own listeners, so that function is held indirectly.
    const listeners: { detach?: () => void } = {}
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      deadline.signal.removeEventListener("abort", expired)
      listeners.detach?.()
      finish()
    }
    const expired = () => settle(() => reject(refusal(deadline, address, waitedOn)))
    deadline.signal.addEventListener("abort", expired, { once: true })
    listeners.detach = start((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)))
    if (settled) listeners.detach()
  })
}

function awaitOpen(socket: WebSocket, deadline: OperationDeadline, address: string): Promise<void> {
  return bounded<void>(deadline, address, "accept the connection", (resolve, reject) => {
    const opened = () => resolve()
    const failed = (error: Error) => reject(error)
    const closed = () => reject(new Error(`The daemon at ${address} closed the connection`))
    socket.once("open", opened)
    socket.once("error", failed)
    socket.once("close", closed)
    return () => {
      socket.off("open", opened)
      socket.off("error", failed)
      socket.off("close", closed)
    }
  })
}

function exchange(
  socket: WebSocket,
  deadline: OperationDeadline,
  address: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return bounded<unknown>(deadline, address, `answer ${method}`, (resolve, reject) => {
    // The daemon broadcasts notifications on the same socket, so only the reply
    // carrying this request's id may settle the wait, and a socket that closes
    // first must reject rather than leave the caller waiting.
    // Valid JSON is not yet a reply: null, a number, an array or a
    // notification is ignored. A frame that answers this request but is not a
    // well-formed response still settles it, without repeating its text.
    const receive = (data: { toString(): string }) => {
      let value: unknown
      try {
        value = JSON.parse(data.toString())
      } catch { return }
      const reply = rpcResponseSchema.safeParse(value)
      if (!reply.success) {
        if (typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value && value.id === id) {
          reject(new Error(`The daemon refused ${method}`))
        }
        return
      }
      if (reply.data.id !== id) return
      if (reply.data.error) reject(new Error(reply.data.error.message))
      else resolve(reply.data.result)
    }
    const closed = () => reject(new Error("The daemon closed the connection"))
    const failed = (error: Error) => reject(error)
    socket.on("message", receive)
    socket.once("close", closed)
    socket.once("error", failed)
    try {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    } catch {
      reject(new Error("The domovoid request could not be sent"))
    }
    return () => {
      socket.off("message", receive)
      socket.off("close", closed)
      socket.off("error", failed)
    }
  })
}

// One bounded JSON-RPC exchange for a one-shot CLI command. The deadline is
// the caller's and is already running before any socket exists, so connect,
// hello and the call cannot outlive it between them.
export async function callDaemonOnce(input: {
  target: CliRpcTarget
  token: string
  method: string
  params: Record<string, unknown>
  deadline: OperationDeadline
}): Promise<unknown> {
  input.deadline.throwIfExpired()
  const address = describedAddress(input.target)
  const socket = new WebSocket(endpointUrl(input.target), {
    headers: { authorization: `Bearer ${input.token}` },
    maxPayload: 2 * 1024 * 1024,
    followRedirects: false,
  })
  // Tearing down a socket that never finished connecting makes ws emit one
  // last error after the refused command has already removed its listeners,
  // and Node turns an unheard error event into an uncaught exception. This
  // listener outlives every phase so the refusal is what the caller sees.
  socket.on("error", () => {})
  try {
    await awaitOpen(socket, input.deadline, address)
    await exchange(socket, input.deadline, address, helloRequestId, "system.hello", {
      client: "cli", clientVersion: buildVersion, protocolVersion,
    })
    return await exchange(socket, input.deadline, address, callRequestId, input.method, input.params)
  } finally {
    // A one-shot exchange has no work left after its complete reply or refusal.
    // A graceful close would start a separate peer-controlled wait after the
    // caller clears its deadline, keeping an answered CLI process alive. Drop
    // the transport on both outcomes, including an unfinished TLS handshake.
    socket.terminate()
  }
}

// One bounded exchange whose connection stays open after the reply, for a
// call whose effect lasts as long as the connection does (the service handoff
// fence). The caller closes it; a refusal or an expired deadline closes it
// here. The reply limit is the daemon's own message limit, because the daemon
// broadcasts on this socket while it is held and a larger frame would close it.
export async function callDaemonHeld(input: {
  target: CliRpcTarget
  token: string
  method: string
  params: Record<string, unknown>
  deadline: OperationDeadline
}): Promise<{ result: unknown; close: () => void }> {
  input.deadline.throwIfExpired()
  const address = describedAddress(input.target)
  const socket = new WebSocket(endpointUrl(input.target), {
    headers: { authorization: `Bearer ${input.token}` },
    maxPayload: maximumRpcMessageBytes,
    followRedirects: false,
  })
  socket.on("error", () => {})
  try {
    await awaitOpen(socket, input.deadline, address)
    await exchange(socket, input.deadline, address, helloRequestId, "system.hello", {
      client: "cli", clientVersion: buildVersion, protocolVersion,
    })
    const result = await exchange(socket, input.deadline, address, callRequestId, input.method, input.params)
    return { result, close: () => socket.terminate() }
  } catch (error) {
    socket.terminate()
    throw error
  }
}

// The whole command, not just its connect, is bounded by one clock started
// before the socket is allocated.
export async function callDaemon(input: {
  target: CliRpcTarget
  token: string
  method: string
  params: Record<string, unknown>
  timeoutMs?: number
}): Promise<unknown> {
  const deadline = OperationDeadline.start(input.timeoutMs ?? defaultCliCommandTimeoutMs)
  try {
    return await callDaemonOnce({ ...input, deadline })
  } finally {
    deadline.clear()
  }
}

// A reply can be a well-formed response whose result is not the method's
// shape. It is refused the way a malformed reply is, in the same words, rather
// than surfacing the schema's own error.
export function readDaemonResult<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`The daemon refused ${method}`)
  return result.data
}
