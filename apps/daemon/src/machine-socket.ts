import { WebSocket } from "ws"

import type { MachineConnection } from "./machine-dial.js"

export const defaultMachineHandshakeTimeoutMs = 15_000

type PendingCall = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

// The daemon's own client to another daemon. It carries the transfer calls and
// nothing else, so it stays a single authenticated socket rather than the full
// workspace client.
export function openMachineSocket(input: {
  endpoint: string
  credential: string
  handshakeTimeoutMs?: number
}): Promise<MachineConnection> {
  return new Promise<MachineConnection>((resolve, reject) => {
    const socket = new WebSocket(input.endpoint)
    const pending = new Map<number, PendingCall>()
    let requestId = 0
    let ready = false

    const handshake = setTimeout(() => {
      if (ready) return
      reject(new Error("That machine did not answer"))
      socket.close()
    }, input.handshakeTimeoutMs ?? defaultMachineHandshakeTimeoutMs)
    handshake.unref?.()

    const send = (method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((settle, fail) => {
        requestId += 1
        const id = requestId
        pending.set(id, { resolve: settle, reject: fail })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })

    socket.on("error", () => {
      if (!ready) reject(new Error("That machine did not answer"))
    })

    socket.on("close", () => {
      clearTimeout(handshake)
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

    socket.on("open", () => {
      // The credential is presented once, in the handshake, before any transfer
      // call is made.
      send("system.hello", {
        client: "desktop",
        clientVersion: "0.0.1",
        authToken: input.credential,
      }).then(
        () => {
          ready = true
          clearTimeout(handshake)
          resolve({
            call: (method, params) => send(method, params),
            close: () => socket.close(),
          })
        },
        (error: unknown) => {
          clearTimeout(handshake)
          reject(error instanceof Error ? error : new Error("That machine refused this daemon"))
          socket.close()
        },
      )
    })
  })
}
