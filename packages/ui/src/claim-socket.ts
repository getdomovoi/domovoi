import type { ClaimConnection } from "./claim-machine.js"
import { type Deadline, DeadlineExceededError, describeTarget } from "./deadline.js"

type PendingClaim = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

// Pairing happens before this device holds any credential, so it cannot use the
// authenticated client. This is a single pre-authentication socket that carries
// one request and closes. The deadline it is given is the pairing's own, so the
// open, the claim, and the greeting all count against the same budget.
export function openClaimConnection(
  endpoint: string,
  deadline: Deadline,
): Promise<ClaimConnection> {
  const target = describeTarget(endpoint)
  if (deadline.expired) {
    return Promise.reject(new DeadlineExceededError("open", target, deadline.budgetMs))
  }
  return new Promise<ClaimConnection>((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    const listeners = new AbortController()
    const pending = new Map<number, PendingClaim>()
    let requestId = 0
    let opened = false
    let stopped = false

    const failPending = (describe: (claim: PendingClaim) => Error) => {
      const claims = [...pending.values()]
      pending.clear()
      for (const claim of claims) claim.reject(describe(claim))
    }
    // Whatever ends the socket, a claim still waiting on it is answered before
    // the listeners go, since after that nothing else could reject it.
    const stop = () => {
      if (stopped) return
      stopped = true
      failPending(() => new Error("The machine closed the connection"))
      listeners.abort()
      socket.close()
    }

    // A machine that accepts the socket and then says nothing, or answers the
    // open and then never the claim, would leave the pairing dialog waiting
    // with no way to report the failure.
    deadline.signal.addEventListener("abort", () => {
      if (!opened) reject(new DeadlineExceededError("open", target, deadline.budgetMs))
      failPending((claim) => new DeadlineExceededError(claim.method, target, deadline.budgetMs))
      stop()
    }, { once: true, signal: listeners.signal })

    socket.addEventListener("error", () => {
      if (!opened) reject(new Error(`Cannot reach ${endpoint}`))
      stop()
    }, { once: true, signal: listeners.signal })

    socket.addEventListener("close", () => {
      if (!opened) reject(new Error("The machine closed the connection"))
      stop()
    }, { signal: listeners.signal })

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
    }, { signal: listeners.signal })

    socket.addEventListener("open", () => {
      opened = true
      resolve({
        call: (method, params) => new Promise<unknown>((settle, fail) => {
          if (deadline.expired) {
            fail(new DeadlineExceededError(method, target, deadline.budgetMs))
            return
          }
          if (stopped) {
            fail(new Error("The machine closed the connection"))
            return
          }
          requestId += 1
          const id = requestId
          pending.set(id, { method, resolve: settle, reject: fail })
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        }),
        close: stop,
      })
    }, { once: true, signal: listeners.signal })
  })
}
