import { z } from "zod"

import { deviceLabelSchema, pairingCodeSchema } from "./devices.js"
import {
  fleetDirectEndpointSchema,
  fleetEntryMachineId,
  fleetPendingOperationSchema,
  fleetSnapshotSchema,
  type FleetPendingOperation,
  type FleetSnapshot,
} from "./fleet.js"
import { clientKindSchema, machineIdSchema } from "./identifiers.js"

// Root-authenticated local clients initiate enrollment; the daemon owns claim,
// machine hello and heartbeat on one connection. No credential reaches the UI.
// This admits daemon-to-daemon calls only, not remote client Use or Terminal.
export const fleetEnrollParamsSchema = z.object({
  endpoint: fleetDirectEndpointSchema,
  code: pairingCodeSchema,
  sourceDeviceLabel: deviceLabelSchema,
  client: clientKindSchema,
  expectedMachineId: machineIdSchema.optional(),
}).strict()

export const fleetEnrollRefusalSchema = z.enum([
  "pairing-refused",
  "target-unreachable",
  "protocol-mismatch",
  "identity-mismatch",
  "target-description-invalid",
  "self-enrollment",
  "credential-store-unavailable",
  "fleet-unavailable",
  "fleet-limit",
  "operation-in-progress",
])

export const fleetForgetParamsSchema = z.object({
  machineId: machineIdSchema,
  client: clientKindSchema,
}).strict()

export const fleetForgetRefusalSchema = z.enum([
  "self-forget",
  "not-enrolled",
  "credential-store-unavailable",
  "fleet-unavailable",
  "operation-in-progress",
])

// There is no atomic revocation transaction across machines. Unconfirmed means
// local deletion succeeded but the operator must revoke this machine in the
// target's Devices list. It never means the remote credential is known revoked.
export const fleetRemoteRevocationSchema = z.enum(["confirmed", "unconfirmed"])

function refinePendingOperation(
  result: { operation: FleetPendingOperation; fleet: FleetSnapshot },
  context: z.RefinementCtx,
): void {
  const operation = result.operation
  const entry = result.fleet.entries.find((entry) => fleetEntryMachineId(entry) === operation.machineId)
  if (entry?.kind !== "pending" || entry.id !== operation.id
    || entry.operation !== operation.operation || entry.startedAt !== operation.startedAt) {
    context.addIssue({ code: "custom", path: ["fleet"], message: "An unfinished operation must remain visible in the fleet" })
  }
}

export const fleetEnrollResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("enrolled"),
    machineId: machineIdSchema,
    fleet: fleetSnapshotSchema,
  }).strict().superRefine((result, context) => {
    const entry = result.fleet.entries.find((entry) => fleetEntryMachineId(entry) === result.machineId)
    if (entry?.kind !== "machine" || entry.machine.self || entry.machine.verifiedRoute === undefined) {
      context.addIssue({ code: "custom", path: ["fleet"], message: "Enrollment must return the authenticated remote machine and its verified route" })
    }
  }),
  z.object({
    outcome: z.literal("pending"),
    operation: fleetPendingOperationSchema.extend({ operation: z.literal("enroll") }),
    fleet: fleetSnapshotSchema,
  }).strict().superRefine(refinePendingOperation),
  z.object({
    outcome: z.literal("refused"),
    reason: fleetEnrollRefusalSchema,
  }).strict(),
])

export const fleetForgetResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("forgotten"),
    machineId: machineIdSchema,
    remoteRevocation: fleetRemoteRevocationSchema,
    fleet: fleetSnapshotSchema,
  }).strict().superRefine((result, context) => {
    if (result.fleet.entries.some((entry) => fleetEntryMachineId(entry) === result.machineId)) {
      context.addIssue({ code: "custom", path: ["fleet"], message: "A forgotten machine cannot remain in the fleet" })
    }
  }),
  z.object({
    outcome: z.literal("pending"),
    operation: fleetPendingOperationSchema.extend({ operation: z.literal("forget") }),
    remoteRevocation: fleetRemoteRevocationSchema,
    fleet: fleetSnapshotSchema,
  }).strict().superRefine(refinePendingOperation),
  z.object({
    outcome: z.literal("refused"),
    reason: fleetForgetRefusalSchema,
  }).strict(),
])

export type FleetEnrollParams = z.infer<typeof fleetEnrollParamsSchema>
export type FleetEnrollRefusal = z.infer<typeof fleetEnrollRefusalSchema>
export type FleetEnrollResult = z.infer<typeof fleetEnrollResultSchema>
export type FleetForgetParams = z.infer<typeof fleetForgetParamsSchema>
export type FleetForgetRefusal = z.infer<typeof fleetForgetRefusalSchema>
export type FleetForgetResult = z.infer<typeof fleetForgetResultSchema>
export type FleetRemoteRevocation = z.infer<typeof fleetRemoteRevocationSchema>
