import type { TransportCandidate } from "@getdomovoi/protocol"

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])
const wildcardHosts = new Set(["0.0.0.0", "::", "[::]"])

function endpointHost(host: string): string {
  // An IPv6 literal has to be bracketed or the URL will not parse.
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export type AdvertisedTransportInput = {
  host: string
  port: number
  tls?: boolean
  advertiseHost?: string
}

// The daemon advertises only endpoints something can actually dial, and only
// where a credential is safe to send: loopback, or an encrypted listener under
// a name it is reachable by. A wildcard bind address is not such a name.
export function advertisedTransports(input: AdvertisedTransportInput): TransportCandidate[] {
  if (loopbackHosts.has(input.host)) {
    return [{
      kind: "local",
      endpoint: `ws://${endpointHost(input.host)}:${input.port}/rpc`,
      authenticated: true,
    }]
  }

  if (!input.tls) return []

  const reachableHost = input.advertiseHost
    ?? (wildcardHosts.has(input.host) ? undefined : input.host)
  if (!reachableHost || wildcardHosts.has(reachableHost)) return []

  return [{
    kind: "lan",
    endpoint: `wss://${endpointHost(reachableHost)}:${input.port}/rpc`,
    authenticated: true,
  }]
}
