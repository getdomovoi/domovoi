import { WebSocket } from "ws"

import { protocolVersion, systemHelloResultSchema } from "@getdomovoi/protocol"

import type { MachineConnection } from "./machine-dial.js"

export const defaultMachineHandshakeTimeoutMs = 15_000
export const defaultMachineCallTimeoutMs = 120_000
export const defaultMaximumPendingCalls = 64

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

// The dialer decides which endpoint to use; this refuses to carry a credential
// over one that could be watched, whatever decided it.
function refusesPlaintext(endpoint: string): boolean {
  if (endpoint.startsWith("wss://")) return false
  try {
    return !loopbackHosts.has(new URL(endpoint).hostname)
  } catch {
    return true
  }
}

// A handshake that fails the snapshot schema is usually a version step, and the
// version it names is the one this dialer has to report.
function spokenProtocolVersion(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const spoken = (value as Record<string, unknown>).protocolVersion
  return typeof spoken === "string" ? spoken : undefined
}

type PendingCall = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

// The daemon's own client to another daemon. It carries the transfer calls and
// nothing else, so it stays a single authenticated socket rather than the full
// workspace client.
export function openMachineSocket(input: {
  endpoint: string
  expectedMachineId: string
  credential: string
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
  maximumPendingCalls?: number
  signal?: AbortSignal
  // Tests drive these rather than waiting on a real clock.
  scheduler?: {
    setTimeout: (callback: () => void, delayMs: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}): Promise<MachineConnection> {
  if (input.signal?.aborted) {
    return Promise.reject(new Error("The transfer was cancelled"))
  }
  if (refusesPlaintext(input.endpoint)) {
    return Promise.reject(new Error("Refusing to authenticate over an unencrypted connection"))
  }
  const scheduler = input.scheduler ?? {
    setTimeout: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs)
      handle.unref?.()
      return handle
    },
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const callTimeoutMs = input.callTimeoutMs ?? defaultMachineCallTimeoutMs
  const maximumPendingCalls = input.maximumPendingCalls ?? defaultMaximumPendingCalls
  return new Promise<MachineConnection>((resolve, reject) => {
    const socket = new WebSocket(input.endpoint)
    const pending = new Map<number, PendingCall>()
    let requestId = 0
    let ready = false

    const handshake = scheduler.setTimeout(() => {
      if (ready) return
      reject(new Error("That machine did not answer"))
      socket.close()
    }, input.handshakeTimeoutMs ?? defaultMachineHandshakeTimeoutMs)

    const send = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      new Promise<unknown>((settle, fail) => {
        const cancellation = signal ?? input.signal
        if (cancellation?.aborted) {
          fail(new Error("The transfer was cancelled"))
          return
        }
        // A socket that is closing will not transmit, and a call it never sent
        // would wait forever.
        if (socket.readyState !== WebSocket.OPEN) {
          fail(new Error("The machine connection is closed"))
          return
        }
        // A machine that answers the handshake and then says nothing must not
        // be able to grow this daemon's memory one call at a time.
        if (pending.size >= maximumPendingCalls) {
          fail(new Error("Too many calls are waiting on that machine"))
          return
        }
        requestId += 1
        const id = requestId
        const deadline = scheduler.setTimeout(() => {
          if (!pending.delete(id)) return
          fail(new Error("That machine stopped answering"))
        }, callTimeoutMs)
        // A cancelled transfer stops waiting now rather than at the deadline.
        const abort = () => {
          if (!pending.delete(id)) return
          scheduler.clearTimeout(deadline)
          fail(new Error("The transfer was cancelled"))
        }
        cancellation?.addEventListener("abort", abort, { once: true })
        const settled = (finish: () => void) => {
          scheduler.clearTimeout(deadline)
          cancellation?.removeEventListener("abort", abort)
          finish()
        }
        pending.set(id, {
          resolve: (result) => settled(() => settle(result)),
          reject: (error) => settled(() => fail(error)),
        })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })

    socket.on("error", () => {
      if (!ready) reject(new Error("That machine did not answer"))
    })

    socket.on("close", () => {
      scheduler.clearTimeout(handshake)
      const closed = new Error("The machine closed the connection")
      for (const call of pending.values()) call.reject(closed)
      pending.clear()
      if (!ready) reject(closed)
    })

    socket.on("message", (data) => {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
      try {
        message = JSON.parse(data.toString()) as typeof message
      } catch {
        return
      }
      if (typeof message.id !== "number") return
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      if (message.error) {
        const described = typeof message.error.message === "string"
          ? message.error.message
          : "That machine refused the request"
        call.reject(new Error(described))
        return
      }
      call.resolve(message.result)
    })

    input.signal?.addEventListener("abort", () => {
      if (ready) return
      scheduler.clearTimeout(handshake)
      reject(new Error("The transfer was cancelled"))
      socket.close()
    }, { once: true })

    socket.on("open", () => {
      // The credential is presented once, in the handshake, before any transfer
      // call is made, and the peer's answer is checked before this daemon says
      // anything else to it.
      send("system.hello", {
        client: "machine",
        clientVersion: "0.0.1",
        protocolVersion,
        authToken: input.credential,
      }).then(
        (result: unknown) => {
          const snapshot = systemHelloResultSchema.safeParse(result)
          if (!snapshot.success) {
            const spoken = spokenProtocolVersion(result)
            scheduler.clearTimeout(handshake)
            reject(spoken === undefined
              ? new Error("That machine answered the handshake with an invalid result")
              : new Error(`That machine speaks protocol ${spoken}, this daemon speaks ${protocolVersion}`))
            socket.close()
            return
          }
          if (snapshot.data.machine.id !== input.expectedMachineId) {
            scheduler.clearTimeout(handshake)
            reject(new Error("The endpoint answered as a different machine"))
            socket.close()
            return
          }
          ready = true
          scheduler.clearTimeout(handshake)
          resolve({
            call: (method, params, signal) => send(method, params, signal),
            close: () => socket.close(),
          })
        },
        (error: unknown) => {
          scheduler.clearTimeout(handshake)
          reject(error instanceof Error ? error : new Error("That machine refused this daemon"))
          socket.close()
        },
      )
    })
  })
}
