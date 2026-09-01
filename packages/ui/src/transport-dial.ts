import { orderedTransports, type TransportCandidate } from "@getdomovoi/protocol"

export class TransportDialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransportDialError"
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
  connect: (attempt: { endpoint: string; credential: string }) => Promise<Connection>
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
  for (const candidate of usable) {
    try {
      return { transport: candidate, connection: await input.connect({
        endpoint: candidate.endpoint,
        credential: input.credential,
      }) }
    } catch {
      // The failure text is deliberately not carried: a transport error can
      // quote the request that produced it, credential included.
      refusedBy.push(candidate.kind)
    }
  }

  throw new TransportDialError(
    `No transport reached that machine${refusedBy.length > 0 ? ` (tried ${refusedBy.join(", ")})` : ""}`,
  )
}
