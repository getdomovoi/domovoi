import { z } from "zod"

import { machineIdSchema } from "./identifiers.js"
import { transportCandidateSchema } from "./transport.js"

export const fleetClientRouteParamsSchema = z.object({
  machineId: machineIdSchema,
  // Source-local routes are useful only to a client on the source machine.
  // A remote browser opts out instead of treating the source's localhost as its own.
  allowSourceLocal: z.boolean().optional(),
}).strict()

export const fleetClientRouteRefusalSchema = z.enum([
  "not-enrolled", "machine-unavailable", "pairing-required",
  "credential-store-unavailable", "protocol-mismatch", "identity-mismatch",
  "client-route-unavailable", "route-timeout",
])

export const fleetClientRouteResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ready"), machineId: machineIdSchema,
    transport: transportCandidateSchema.refine((transport) => transport.kind !== "relay", "Client relay admission is not implemented"),
  }).strict(),
  z.object({ outcome: z.literal("refused"), reason: fleetClientRouteRefusalSchema }).strict(),
])

export type FleetClientRouteParams = z.infer<typeof fleetClientRouteParamsSchema>
export type FleetClientRouteResult = z.infer<typeof fleetClientRouteResultSchema>
export type FleetClientRouteRefusal = z.infer<typeof fleetClientRouteRefusalSchema>
