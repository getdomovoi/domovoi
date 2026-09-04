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

// A successful authenticated exchange proves a route works; it need not be in
// the target's advertisements (for example MagicDNS or an external port forward).
// No credential-bearing URL is retained. Only loopback permits plaintext.
export const fleetDirectEndpointSchema = z.string().max(2048).url().refine((endpoint) => {
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || url.search || url.hash) return false
    return url.protocol === "wss:" || (url.protocol === "ws:"
      && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
  } catch {
    return false
  }
}, "A direct endpoint requires TLS outside loopback and cannot contain credentials, query or fragment")

export const fleetVerifiedRouteSchema = z.object({
  endpoint: fleetDirectEndpointSchema,
  lastAuthenticatedAt: z.string().datetime({ offset: true }),
}).strict()

// `direct` is a source observation, not a new target-advertised transport kind.
export const fleetConnectionKindSchema = z.enum([...connectionKindSchema.options, "direct"])

const fleetMachineDescriptorObject = z.object({
  id: machineIdSchema,
  label: z.string().trim().min(1).max(128),
  platform: z.string().trim().min(1).max(64),
  arch: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(64),
  capabilities: z.array(machineCapabilitySchema).max(16),
  protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  // Only endpoints the dialer would accept: the schema refuses an
  // unauthenticated candidate, so a machine cannot advertise one.
  transports: z.array(transportCandidateSchema).max(8),
}).strict()

// Only target-authored facts cross the heartbeat RPC. Health, route provenance,
// connection kind and timestamps are observations made by the receiving daemon.
export const fleetMachineDescriptorSchema = fleetMachineDescriptorObject.superRefine(refineCapabilities)

const fleetMachineFactsObject = fleetMachineDescriptorObject.extend({
  connection: fleetConnectionKindSchema,
  verifiedRoute: fleetVerifiedRouteSchema.optional(),
}).strict()

function refineObservedFacts(machine: z.infer<typeof fleetMachineFactsObject>, context: z.RefinementCtx): void {
  refineCapabilities(machine, context)
  if (machine.connection === "direct" && machine.verifiedRoute === undefined) {
    context.addIssue({ code: "custom", path: ["verifiedRoute"], message: "A direct connection requires a source-verified route" })
  }
}

export const fleetMachineFactsSchema = fleetMachineFactsObject.superRefine(refineObservedFacts)

export const fleetMachineSchema = fleetMachineFactsObject.extend({
  heartbeat: machineHeartbeatSchema,
  // Health is derived by the daemon from the heartbeat and version facts, so a
  // machine never reports its own verdict.
  health: fleetHealthSchema,
  self: z.boolean(),
}).strict().superRefine((machine, context) => {
  refineObservedFacts(machine, context)
  if (machine.self && machine.verifiedRoute !== undefined) {
    context.addIssue({ code: "custom", path: ["verifiedRoute"], message: "A source-verified remote route cannot describe this daemon" })
  }
})

// Cross-store operations are resumed by the daemon, not by a client button.
// Never publish their credential digest, keychain bytes or guessed machine facts.
export const fleetPendingOperationSchema = z.object({
  kind: z.literal("pending"),
  id: z.string().uuid(),
  machineId: machineIdSchema,
  operation: z.enum(["enroll", "forget"]),
  startedAt: z.string().datetime({ offset: true }),
}).strict()

export const fleetEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), machine: fleetMachineSchema }).strict(),
  fleetPendingOperationSchema,
  // Legacy keyring entries have an identity, but no authenticated descriptor.
  z.object({ kind: z.literal("unenrolled"), machineId: machineIdSchema }).strict(),
])

export function fleetEntryMachineId(entry: FleetEntry): string {
  return entry.kind === "machine" ? entry.machine.id : entry.machineId
}

export const fleetSnapshotSchema = z.object({
  entries: z.array(fleetEntrySchema).max(maximumFleetMachines),
}).strict().superRefine((fleet, context) => {
  const ids = fleet.entries.map(fleetEntryMachineId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "A fleet can have only one lifecycle entry per machine",
    })
  }
  if (fleet.entries.filter((entry) => entry.kind === "machine" && entry.machine.self).length > 1) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "Only one fleet machine can be this daemon",
    })
  }
})

// Sent only to authenticated clients. Reconnect always relists. A slow client
// must reconnect rather than silently coalescing or losing lifecycle changes.
export const fleetChangedNotificationSchema = fleetSnapshotSchema

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
export type FleetMachineDescriptor = z.infer<typeof fleetMachineDescriptorSchema>
export type FleetVerifiedRoute = z.infer<typeof fleetVerifiedRouteSchema>
export type FleetConnectionKind = z.infer<typeof fleetConnectionKindSchema>
export type FleetPendingOperation = z.infer<typeof fleetPendingOperationSchema>
export type FleetEntry = z.infer<typeof fleetEntrySchema>
export type MachineHeartbeat = z.infer<typeof machineHeartbeatSchema>
export type HeartbeatState = z.infer<typeof heartbeatStateSchema>
export type FleetMachine = z.infer<typeof fleetMachineSchema>
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>
export type FleetChangedNotification = z.infer<typeof fleetChangedNotificationSchema>
