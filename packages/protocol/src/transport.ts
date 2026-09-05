import { z } from "zod"

import { connectionKindSchema } from "./schema.js"

// Private transports first, relay last: repository bytes should leave the
// machine over the closest link that works.
export const transportPreference = [
  "local",
  "wsl",
  "lan",
  "tailnet",
  "ssh",
  "relay",
] as const satisfies readonly z.infer<typeof connectionKindSchema>[]

// URL normalization happens before locality checks. This is the same narrow
// allowlist used for source-verified routes and machine sockets, not DNS-based
// trust or a claim that an arbitrary hostname resolves to this machine.
export function isTransportLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "[::1]", "localhost"].includes(host)
}

function endpointUrl(endpoint: string): URL | undefined {
  try { return new URL(endpoint) } catch { return undefined }
}

const websocketEndpointSchema = z.string().max(2048).url().refine((endpoint) => {
  const url = endpointUrl(endpoint)
  return url !== undefined && (url.protocol === "ws:" || url.protocol === "wss:")
    && !url.username && !url.password && !url.search && !url.hash
}, "Transport endpoint must be a WebSocket URL without credentials, query or fragment")

export const loopbackTransportEndpointSchema = websocketEndpointSchema.refine((endpoint) => {
  const url = endpointUrl(endpoint)
  return url !== undefined && isTransportLoopbackHost(url.hostname)
}, "Transport endpoint must use normalized loopback")

const remoteTransportEndpointSchema = websocketEndpointSchema.refine((endpoint) => {
  const url = endpointUrl(endpoint)
  return url !== undefined && url.protocol === "wss:"
    && !isTransportLoopbackHost(url.hostname) && !["0.0.0.0", "[::]"].includes(url.hostname)
}, "Remote transport endpoint requires TLS and a non-loopback, non-wildcard host")

// A verified endpoint is an observation, not an advertised network kind.
// Reuse its credential-protection rule at enrollment and at the socket seam.
export const directTransportEndpointSchema = websocketEndpointSchema.refine((endpoint) => {
  const url = endpointUrl(endpoint)
  return url !== undefined && (url.protocol === "wss:"
    || (url.protocol === "ws:" && isTransportLoopbackHost(url.hostname)))
}, "A direct endpoint requires TLS outside loopback")

// No new wire flags: policy is fixed by the variant, not caller-asserted.
// These are channel capabilities, not machine features, credential authority,
// or proof of liveness. A successful handshake must still verify the peer.
const directCapabilities = ["rpc", "terminals", "previews"] as const
export const transportContract = {
  local: { locality: "loopback", protection: "loopback-or-tls", configuration: "none", availability: "candidate", capabilities: directCapabilities },
  wsl: { locality: "loopback", protection: "loopback-or-tls", configuration: "none", availability: "candidate", capabilities: directCapabilities },
  lan: { locality: "remote", protection: "tls", configuration: "none", availability: "candidate", capabilities: directCapabilities },
  tailnet: { locality: "remote", protection: "tls", configuration: "none", availability: "candidate", capabilities: directCapabilities },
  ssh: { locality: "loopback", protection: "loopback-or-tls", configuration: "explicit", availability: "when-configured", capabilities: directCapabilities },
  relay: { locality: "remote", protection: "encrypted-channel-required", configuration: "unsupported", availability: "unavailable", capabilities: [] },
} as const satisfies Record<z.infer<typeof connectionKindSchema>, {
  locality: "loopback" | "remote"
  protection: "loopback-or-tls" | "tls" | "encrypted-channel-required"
  configuration: "none" | "explicit" | "unsupported"
  availability: "candidate" | "when-configured" | "unavailable"
  capabilities: readonly ("rpc" | "terminals" | "previews")[]
}>

// Local and WSL describe a loopback hop, not a remotely asserted destination.
// LAN/tailnet remain operator classifications, never proof of network membership.
// SSH describes a source-configured forward; a peer cannot configure one here.
// Relay is a reserved, non-dialable record until its encrypted contract exists.
export const transportCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), endpoint: loopbackTransportEndpointSchema, authenticated: z.literal(true) }).strict(),
  z.object({ kind: z.literal("wsl"), endpoint: loopbackTransportEndpointSchema, authenticated: z.literal(true) }).strict(),
  z.object({ kind: z.literal("lan"), endpoint: remoteTransportEndpointSchema, authenticated: z.literal(true) }).strict(),
  z.object({ kind: z.literal("tailnet"), endpoint: remoteTransportEndpointSchema, authenticated: z.literal(true) }).strict(),
  z.object({ kind: z.literal("ssh"), endpoint: loopbackTransportEndpointSchema, authenticated: z.literal(true), configured: z.boolean() }).strict(),
  z.object({ kind: z.literal("relay"), endpoint: remoteTransportEndpointSchema, authenticated: z.literal(true) }).strict(),
])

export const transportCandidatesSchema = z.array(transportCandidateSchema).max(16)

export type TransportCandidate = z.infer<typeof transportCandidateSchema>

export type TransportSelection = {
  // Compatibility input only. No value can enable an unimplemented relay.
  relayAvailable?: boolean
}

export function orderedTransports(candidates: TransportCandidate[]): TransportCandidate[] {
  return [...transportCandidatesSchema.parse(candidates)].sort(
    (left, right) => transportPreference.indexOf(left.kind) - transportPreference.indexOf(right.kind),
  )
}

export function selectTransport(
  candidates: TransportCandidate[],
  _options: TransportSelection = {},
): TransportCandidate | undefined {
  return usableTransports(candidates)[0]
}

// Display ordering may retain unavailable entries. Every dialer must use this
// eligibility boundary, so an SSH toggle or reserved relay means the same thing
// in every consumer. Network failure and deadline-aware fallback remain local.
export function usableTransports(candidates: TransportCandidate[]): TransportCandidate[] {
  return orderedTransports(candidates).filter((candidate) => {
    if (candidate.kind === "ssh") return candidate.configured
    return transportContract[candidate.kind].availability === "candidate"
  })
}
