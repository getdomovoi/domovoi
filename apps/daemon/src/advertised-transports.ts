import { isTransportLoopbackHost, transportCandidatesSchema, type TransportCandidate } from "@getdomovoi/protocol"

import { endpointHost } from "./transport-config.js"

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])
const wildcardHosts = new Set(["0.0.0.0", "::", "[::]"])

export type AdvertisedTransportInput = {
  host: string
  port: number
  tls?: boolean
  advertiseHost?: string
  tailnetHost?: string
  // TailnetReach: the tailnet listener beside a loopback one is listening, on
  // the same port. Its route is advertised under tailnetHost.
  tailnetListener?: boolean
}

// The daemon advertises only endpoints something can actually dial, and only
// where a credential is safe to send: loopback, or an encrypted listener under
// a name it is reachable by. A wildcard bind address is not such a name.
export function advertisedTransports(input: AdvertisedTransportInput): TransportCandidate[] {
  const tailnetEndpoint = input.tailnetHost
    ? `wss://${new URL(`wss://${endpointHost(input.tailnetHost)}/`).hostname}:${input.port}/rpc`
    : undefined
  if (loopbackHosts.has(input.host)) {
    return transportCandidatesSchema.parse([{
      kind: "local",
      endpoint: `${input.tls ? "wss" : "ws"}://${endpointHost(input.host)}:${input.port}/rpc`,
      authenticated: true,
    }, ...(input.tailnetListener && tailnetEndpoint ? [{ kind: "tailnet", endpoint: tailnetEndpoint, authenticated: true }] : [])])
  }

  if (!input.tls) return []

  const reachableHost = input.advertiseHost
    ?? (wildcardHosts.has(input.host) ? undefined : input.host)
  const candidates: TransportCandidate[] = []
  if (reachableHost && !wildcardHosts.has(reachableHost)) {
    const endpoint = `wss://${endpointHost(reachableHost)}:${input.port}/rpc`
    // An explicit classification outranks the inferred default for that same
    // endpoint. Do not insert a preferred LAN duplicate ahead of a tailnet.
    if (!tailnetEndpoint || new URL(endpoint).href !== new URL(tailnetEndpoint).href) {
      candidates.push({ kind: isTransportLoopbackHost(new URL(endpoint).hostname) ? "local" : "lan", endpoint, authenticated: true })
    }
  }
  if (tailnetEndpoint) candidates.push({
    kind: "tailnet",
    endpoint: tailnetEndpoint,
    authenticated: true,
  })
  return transportCandidatesSchema.parse(candidates)
}
