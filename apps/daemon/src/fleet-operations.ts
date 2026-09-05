import {
  fleetMachineFactsSchema,
  fleetPendingOperationSchema,
  fleetRemoteRevocationSchema,
  fleetVerifiedRouteSchema,
  machineIdSchema,
  sha256DigestSchema,
  type FleetPendingOperation,
} from "@getdomovoi/protocol"
import { z } from "zod"

const operation = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  machineId: machineIdSchema,
  startedAt: z.string().datetime({ offset: true }),
}).strict()

export const fleetEnrollmentOperationSchema = operation.extend({
  kind: z.literal("enroll"),
  facts: fleetMachineFactsSchema.safeExtend({ verifiedRoute: fleetVerifiedRouteSchema }),
  credentialDigest: sha256DigestSchema,
}).strict().superRefine((entry, context) => {
  if (entry.facts.id !== entry.machineId) {
    context.addIssue({ code: "custom", message: "A staged enrollment requires matching authenticated facts and route" })
  }
})

export const fleetForgetOperationSchema = operation.extend({
  kind: z.literal("forget"),
  // Null means the key was already missing when the operator asked to forget.
  credentialDigest: sha256DigestSchema.nullable(),
  remoteRevocation: fleetRemoteRevocationSchema,
}).strict()

export const fleetOperationSchema = z.discriminatedUnion("kind", [
  fleetEnrollmentOperationSchema,
  fleetForgetOperationSchema,
])

export type FleetEnrollmentOperation = z.infer<typeof fleetEnrollmentOperationSchema>
export type FleetForgetOperation = z.infer<typeof fleetForgetOperationSchema>
export type FleetOperation = z.infer<typeof fleetOperationSchema>

export function fleetOperationSummary(entry: FleetOperation): FleetPendingOperation {
  // An explicit projection, not a spread: internal digest/facts never go to UI.
  return fleetPendingOperationSchema.parse({
    kind: "pending", id: entry.id, machineId: entry.machineId,
    operation: entry.kind, startedAt: entry.startedAt,
  })
}
