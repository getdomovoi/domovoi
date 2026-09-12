import { z } from "zod"

import { heartbeatStateSchema } from "./fleet.js"
import { protocolCompatibility, protocolCompatibilitySchema, protocolVersionSchema } from "./protocol-version.js"

export { protocolCompatibility, protocolCompatibilitySchema, type ProtocolCompatibility } from "./protocol-version.js"

export const fleetConnectionStateSchema = z.enum([
  "connected",
  "reconnecting",
  "disconnected",
])

// Ordered from best to worst so a reader can see what each state displaces.
export const fleetHealthSchema = z.enum([
  "healthy",
  "reconnecting",
  "degraded",
  "unreachable",
  "version-mismatch",
  "upgrade-required",
  "pairing-required",
  "credential-store-unavailable",
])

export type FleetConnectionState = z.infer<typeof fleetConnectionStateSchema>
export type FleetHealth = z.infer<typeof fleetHealthSchema>

// The data on a protocolVersionMismatchErrorCode refusal: both versions and
// which side is behind, so a peer grades the refusal without reading the
// sentence that carries the same facts for a person.
export const protocolMismatchSchema = z.object({
  kind: z.literal("protocol-mismatch"),
  daemonProtocolVersion: protocolVersionSchema,
  clientProtocolVersion: protocolVersionSchema,
  compatibility: protocolCompatibilitySchema.exclude(["compatible"]),
}).strict().refine(
  (mismatch) => protocolVersionSchema.safeParse(mismatch.daemonProtocolVersion).success
    && protocolVersionSchema.safeParse(mismatch.clientProtocolVersion).success
    && protocolCompatibility(mismatch.daemonProtocolVersion, mismatch.clientProtocolVersion) === mismatch.compatibility,
  "Compatibility must follow from the two versions",
)

export type ProtocolMismatch = z.infer<typeof protocolMismatchSchema>

export function fleetMachineHealth(input: {
  heartbeat: z.infer<typeof heartbeatStateSchema>
  connection: FleetConnectionState
  protocolVersion: string
  clientProtocolVersion: string
}): FleetHealth {
  // A version problem does not resolve by waiting, so it is reported ahead of
  // reachability, which may recover on its own.
  const compatibility = protocolCompatibility(input.protocolVersion, input.clientProtocolVersion)
  if (compatibility === "machine-behind") return "upgrade-required"
  if (compatibility === "machine-ahead") return "version-mismatch"

  if (input.connection === "reconnecting") return "reconnecting"
  if (input.heartbeat === "offline") return "unreachable"
  if (input.heartbeat === "stale") return "degraded"
  return "healthy"
}
