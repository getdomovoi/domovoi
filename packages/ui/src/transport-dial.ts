import { orderedTransports, type TransportCandidate } from "@getdomovoi/protocol"

import { DeadlineExceededError } from "./deadline.js"

export class TransportDialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransportDialError"
  }
}

export class TransportDialTimeoutError extends TransportDialError {
  readonly target: string
  readonly stage: "open" | "hello" | "route-setup"
  readonly budgetMs: number

  constructor(endpoint: string, timeout: DeadlineExceededError, summary: string) {
    // Only local deadline facts survive. Neither a remote error's text nor
    // endpoint userinfo, path, query or fragment belongs in a refusal.
    const target = new URL(endpoint).origin
    const stage = timeout.stage === "open" ? "open"
      : timeout.stage === "hello" || timeout.stage === "system.hello" ? "hello" : "route-setup"
    super(`${summary}. Timed out during ${stage} at ${target}. Check that route and try again.`)
    this.name = "TransportDialTimeoutError"
    this.target = target
    this.stage = stage
    this.budgetMs = timeout.budgetMs
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return loopbackHosts.has(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

// A credential must never cross a network in the clear, so plaintext is only
// allowed to a loopback endpoint, where it never leaves the machine.
function assertProtectedEndpoint(candidate: TransportCandidate): void {
  if (candidate.endpoint.startsWith("wss://")) return
  if (isLoopbackEndpoint(candidate.endpoint)) return
  throw new TransportDialError(
    `Refusing to authenticate over an unencrypted ${candidate.kind} transport`,
  )
}

export type DialedTransport<Connection> = {
  transport: TransportCandidate
  connection: Connection
}

export async function dialTransport<Connection>(input: {
  candidates: TransportCandidate[]
  credential: string
  connect: (attempt: { endpoint: string; credential: string; remainingCandidates: number }) => Promise<Connection>
  relayAvailable?: boolean
}): Promise<DialedTransport<Connection>> {
  if (!input.credential) throw new TransportDialError("A transport credential is required")

  const relayAvailable = input.relayAvailable ?? true
  const usable = orderedTransports(input.candidates).filter((candidate) => {
    if (candidate.kind === "ssh") return candidate.configured === true
    if (candidate.kind === "relay") return relayAvailable
    return true
  })

  for (const candidate of usable) assertProtectedEndpoint(candidate)

  const refusedBy: string[] = []
  let lastTimeout: { endpoint: string; error: DeadlineExceededError } | undefined
  for (const [index, candidate] of usable.entries()) {
    try {
      return { transport: candidate, connection: await input.connect({
        endpoint: candidate.endpoint,
        credential: input.credential,
        remainingCandidates: usable.length - index,
      }) }
    } catch (error) {
      // The failure text is deliberately not carried: a transport error can
      // quote the request that produced it, credential included.
      refusedBy.push(candidate.kind)
      lastTimeout = error instanceof DeadlineExceededError ? { endpoint: candidate.endpoint, error } : undefined
    }
  }

  const summary = `No transport reached that machine${refusedBy.length > 0 ? ` (tried ${refusedBy.join(", ")})` : ""}`
  if (lastTimeout) throw new TransportDialTimeoutError(lastTimeout.endpoint, lastTimeout.error, summary)
  throw new TransportDialError(summary)
}
