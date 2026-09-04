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

export const transportCandidateSchema = z.object({
  kind: connectionKindSchema,
  endpoint: z.string().url().refine(
    (value) => value.startsWith("ws://") || value.startsWith("wss://"),
    { message: "Transport endpoint must be a WebSocket URL" },
  ),
  // A transport is only a candidate if it authenticates. A private network is
  // not an authentication mechanism, so a tailnet endpoint is no exception.
  authenticated: z.literal(true),
  configured: z.boolean().optional(),
}).strict()

export const transportCandidatesSchema = z.array(transportCandidateSchema).max(16)

export type TransportCandidate = z.infer<typeof transportCandidateSchema>

export type TransportSelection = {
  relayAvailable?: boolean
}

export function orderedTransports(candidates: TransportCandidate[]): TransportCandidate[] {
  return [...transportCandidatesSchema.parse(candidates)].sort(
    (left, right) => transportPreference.indexOf(left.kind) - transportPreference.indexOf(right.kind),
  )
}

export function selectTransport(
  candidates: TransportCandidate[],
  options: TransportSelection = {},
): TransportCandidate | undefined {
  const relayAvailable = options.relayAvailable ?? true
  return orderedTransports(candidates).find((candidate) => {
    // An SSH tunnel is only reached for when someone configured one. A relay
    // is eligible only after its caller has established a configured route;
    // the encrypted route contract is recorded in docs/encrypted-relay.md.
    if (candidate.kind === "ssh") return candidate.configured === true
    if (candidate.kind === "relay") return relayAvailable
    return true
  })
}
