import {
  connectionKindSchema,
  isTransportLoopbackHost,
  usableTransports,
  type TransportCandidate,
} from "@getdomovoi/protocol"

export class TransportDialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransportDialError"
  }
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return isTransportLoopbackHost(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

function invalidTransportError(candidates: TransportCandidate[]): TransportDialError {
  // Preserve the actionable plaintext refusal, but never interpolate unparsed
  // fields or schema errors: even a kind or an unknown field can hold a secret.
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const kind = connectionKindSchema.safeParse(candidate?.kind)
      if (kind.success && typeof candidate?.endpoint === "string"
        && candidate.endpoint.startsWith("ws://") && !isLoopbackEndpoint(candidate.endpoint)) {
        return new TransportDialError(`Refusing to authenticate over an unencrypted ${kind.data} transport`)
      }
    }
  }
  return new TransportDialError(
    "That machine advertises an invalid transport. Refresh its fleet information and check its route configuration.",
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
  // Compatibility input only. It cannot enable an unimplemented relay.
  relayAvailable?: boolean
}): Promise<DialedTransport<Connection>> {
  if (!input.credential) throw new TransportDialError("A transport credential is required")

  let usable: TransportCandidate[]
  try {
    usable = usableTransports(input.candidates)
  } catch {
    throw invalidTransportError(input.candidates)
  }

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
