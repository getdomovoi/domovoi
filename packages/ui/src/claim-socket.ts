import type { ClaimConnection } from "./claim-machine.js"

type PendingClaim = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

// Pairing happens before this device holds any credential, so it cannot use the
// authenticated client. This is a single pre-authentication socket that carries
// one request and closes.
export const defaultClaimOpenTimeoutMs = 10_000

export function openClaimConnection(
  endpoint: string,
  options: { openTimeoutMs?: number } = {},
): Promise<ClaimConnection> {
  return new Promise<ClaimConnection>((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    const pending = new Map<number, PendingClaim>()
    let requestId = 0
    let opened = false
    // A machine that accepts the socket and then says nothing would leave the
    // pairing dialog waiting with no way to report the failure.
    const openTimer = setTimeout(() => {
      if (opened) return
      reject(new Error(`Cannot reach ${endpoint}`))
      socket.close()
    }, options.openTimeoutMs ?? defaultClaimOpenTimeoutMs)

    socket.addEventListener("error", () => {
      clearTimeout(openTimer)
      if (!opened) reject(new Error(`Cannot reach ${endpoint}`))
      socket.close()
    }, { once: true })

    socket.addEventListener("close", () => {
      clearTimeout(openTimer)
      const closed = new Error("The machine closed the connection")
      for (const claim of pending.values()) claim.reject(closed)
      pending.clear()
      if (!opened) reject(closed)
    })

    socket.addEventListener("message", (event) => {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
      try {
        message = JSON.parse(String((event as MessageEvent).data)) as typeof message
      } catch {
        return
      }
      if (typeof message.id !== "number") return
      const claim = pending.get(message.id)
      if (!claim) return
      pending.delete(message.id)
      if (message.error) {
        const described = typeof message.error.message === "string"
          ? message.error.message
          : "The machine refused the pairing"
        claim.reject(new Error(described))
        return
      }
      claim.resolve(message.result)
    })

    socket.addEventListener("open", () => {
      opened = true
      clearTimeout(openTimer)
      resolve({
        call: (method, params) => new Promise<unknown>((settle, fail) => {
          requestId += 1
          const id = requestId
          pending.set(id, { resolve: settle, reject: fail })
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        }),
        close: () => socket.close(),
      })
    }, { once: true })
  })
}
