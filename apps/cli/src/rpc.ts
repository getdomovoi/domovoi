import { WebSocket } from "ws"

import { buildVersion, protocolVersion } from "@getdomovoi/protocol"

export const defaultEndpoint = "ws://127.0.0.1:47831/rpc"
export const defaultTimeoutMs = 15_000

export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DaemonUnreachableError"
  }
}

export type DaemonConnection = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  close(): void
}

// One socket, one hello, then requests by id. Notifications share the socket,
// so only the reply carrying a request's id settles that request, and a socket
// that closes first rejects everything still waiting rather than hanging.
// An unpaired socket may do nothing but claim, and the daemon refuses a hello
// that carries no credential, so pairing skips the hello entirely.
export async function connectToDaemon(input: {
  endpoint: string
  authToken?: string
  hello?: boolean
  timeoutMs?: number
}): Promise<DaemonConnection> {
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
  const socket = new WebSocket(input.endpoint, { maxPayload: 2 * 1024 * 1024, followRedirects: false })
  socket.on("error", () => {})
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 1
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  socket.on("message", (data: { toString(): string }) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(data.toString()) as typeof message } catch { return }
    if (typeof message.id !== "number") return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message ?? "The daemon refused the request"))
    else waiter.resolve(message.result)
  })
  socket.once("close", () => failAll(new DaemonUnreachableError("The daemon closed the connection")))
  socket.once("error", (error: Error) => failAll(error))

  const call = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new DaemonUnreachableError(`The daemon at ${input.endpoint} did not answer ${method} within ${timeoutMs} ms`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    try {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new DaemonUnreachableError(`No daemon answered at ${input.endpoint} within ${timeoutMs} ms. Check that domovoid is running there.`))
    }, timeoutMs)
    socket.once("open", () => { clearTimeout(timer); resolve() })
    socket.once("error", (error: Error) => {
      clearTimeout(timer)
      reject(new DaemonUnreachableError(`Could not reach ${input.endpoint}: ${error.message}`))
    })
  })

  if (input.hello !== false) {
    await call("system.hello", {
      client: "cli", clientVersion: buildVersion, protocolVersion,
      ...(input.authToken === undefined ? {} : { authToken: input.authToken }),
    })
  }

  return { call, close: () => socket.terminate() }
}
