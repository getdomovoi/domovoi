import { z } from "zod"

import { fleetHealthSchema } from "./fleet-health.js"
import { machineIdSchema } from "./identifiers.js"
import { transportCandidateSchema } from "./transport.js"
import { connectionKindSchema } from "./schema.js"

export const maximumFleetMachines = 128
export const staleHeartbeatMs = 30_000
export const offlineHeartbeatMs = 120_000

export { machineIdSchema }

export const machineCapabilitySchema = z.enum([
  "sessions",
  "terminals",
  "previews",
  "worktrees",
  "skills",
])

export const heartbeatStateSchema = z.enum(["online", "stale", "offline"])

export const machineHeartbeatSchema = z.object({
  state: heartbeatStateSchema,
  lastSeenAt: z.string().datetime({ offset: true }),
}).strict()

function refineCapabilities(
  machine: { capabilities: MachineCapability[] },
  context: z.RefinementCtx,
): void {
  if (new Set(machine.capabilities).size !== machine.capabilities.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Machine capabilities must be unique",
    })
  }
}

const fleetMachineFactsObject = z.object({
  id: machineIdSchema,
  label: z.string().trim().min(1).max(128),
  platform: z.string().trim().min(1).max(64),
  arch: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(64),
  connection: connectionKindSchema,
  capabilities: z.array(machineCapabilitySchema).max(16),
  protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  // Only endpoints the dialer would accept: the schema refuses an
  // unauthenticated candidate, so a machine cannot advertise one.
  transports: z.array(transportCandidateSchema).max(8),
}).strict()

export const fleetMachineFactsSchema = fleetMachineFactsObject.superRefine(refineCapabilities)

export const fleetMachineSchema = fleetMachineFactsObject.extend({
  heartbeat: machineHeartbeatSchema,
  // Health is derived by the daemon from the heartbeat and version facts, so a
  // machine never reports its own verdict.
  health: fleetHealthSchema,
  self: z.boolean(),
}).strict().superRefine(refineCapabilities)

export const fleetSnapshotSchema = z.object({
  machines: z.array(fleetMachineSchema).max(maximumFleetMachines),
}).strict().superRefine((fleet, context) => {
  const ids = fleet.machines.map((machine) => machine.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["machines"],
      message: "Fleet machines must have distinct identifiers",
    })
  }
  if (fleet.machines.filter((machine) => machine.self).length > 1) {
    context.addIssue({
      code: "custom",
      path: ["machines"],
      message: "Only one fleet machine can be this daemon",
    })
  }
})

export function machineHeartbeatState(
  lastSeenMs: number,
  nowMs: number,
): z.infer<typeof heartbeatStateSchema> {
  const silence = nowMs - lastSeenMs
  if (silence > offlineHeartbeatMs) return "offline"
  if (silence > staleHeartbeatMs) return "stale"
  return "online"
}

export type MachineCapability = z.infer<typeof machineCapabilitySchema>
export type FleetMachineFacts = z.infer<typeof fleetMachineFactsSchema>
export type MachineHeartbeat = z.infer<typeof machineHeartbeatSchema>
export type HeartbeatState = z.infer<typeof heartbeatStateSchema>
export type FleetMachine = z.infer<typeof fleetMachineSchema>
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>
