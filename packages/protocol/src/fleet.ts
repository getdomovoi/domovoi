import { z } from "zod"

import { fleetHealthSchema } from "./fleet-health.js"
import { machineIdSchema } from "./identifiers.js"
import { directTransportEndpointSchema, transportCandidateSchema } from "./transport.js"
import { connectionKindSchema } from "./schema.js"

export const maximumFleetMachines = 128
export const maximumFleetEntries = 512
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

// A daemon inside a WSL distribution reports linux as its platform, which is
// true and not enough: the fleet needs to say which distribution, and whether
// WSL 2 gives it a network stack of its own.
export const machineWslFactsSchema = z.object({
  distribution: z.string().trim().min(1).max(128),
  version: z.union([z.literal(1), z.literal(2)]),
}).strict()

export const machineHeartbeatSchema = z.object({
  state: heartbeatStateSchema,
  lastSeenAt: z.string().datetime({ offset: true }),
}).strict()

// The facts a machine reports about itself are read in three places: its
// heartbeat, its enrollment descriptor, and the fleet entry built from either.
// One refinement serves all three, so a descriptor no place would keep is
// refused everywhere.
function refineDescriptor(
  machine: { platform: string; capabilities: MachineCapability[]; wsl?: MachineWslFacts | undefined },
  context: z.RefinementCtx,
): void {
  if (new Set(machine.capabilities).size !== machine.capabilities.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Machine capabilities must be unique",
    })
  }
  // Only a linux daemon runs inside a distribution. Any other platform
  // claiming one would be labelled as a WSL machine it is not.
  if (machine.wsl !== undefined && machine.platform !== "linux") {
    context.addIssue({
      code: "custom",
      path: ["wsl"],
      message: "WSL facts describe a linux daemon inside a distribution",
    })
  }
}

// A successful authenticated exchange proves a route works; it need not be in
// the target's advertisements (for example MagicDNS or an external port forward).
// No credential-bearing URL is retained. Only loopback permits plaintext.
export const fleetDirectEndpointSchema = directTransportEndpointSchema

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
  wsl: machineWslFactsSchema.optional(),
}).strict()

// Only target-authored facts cross the heartbeat RPC. Health, route provenance,
// connection kind and timestamps are observations made by the receiving daemon.
export const fleetMachineDescriptorSchema = fleetMachineDescriptorObject.superRefine(refineDescriptor)

const fleetMachineFactsObject = fleetMachineDescriptorObject.extend({
  connection: fleetConnectionKindSchema,
  verifiedRoute: fleetVerifiedRouteSchema.optional(),
}).strict()

function refineObservedFacts(machine: z.infer<typeof fleetMachineFactsObject>, context: z.RefinementCtx): void {
  refineDescriptor(machine, context)
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
  entries: z.array(fleetEntrySchema).max(maximumFleetEntries),
}).strict().superRefine((fleet, context) => {
  // Display validation is not admission: pending journals must remain visible
  // even when recovery discovers no room to promote them. The daemon reserves
  // pending enrollments against its separate admission limit before claiming.
  if (fleet.entries.filter((entry) => entry.kind === "machine").length > maximumFleetMachines) {
    context.addIssue({ code: "custom", path: ["entries"], message: "The fleet machine admission limit is 128" })
  }
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

// An overflow refuses the entire list, not a silently shortened success.
// Legacy keyring indexes predate admission limits and can exceed this bound.
export const fleetSnapshotOverflowSchema = z.object({
  kind: z.literal("fleet-overflow"),
  limit: z.literal(maximumFleetEntries),
  totalEntries: z.number().int().min(maximumFleetEntries + 1).max(Number.MAX_SAFE_INTEGER),
  entriesNotShown: z.number().int().min(maximumFleetEntries + 1).max(Number.MAX_SAFE_INTEGER),
}).strict().refine((overflow) => overflow.entriesNotShown === overflow.totalEntries,
  "An overflow returns no entries")

export type FleetSnapshotOverflow = z.infer<typeof fleetSnapshotOverflowSchema>

// Sent only to authenticated clients. Reconnect always relists. A slow client
// must reconnect rather than silently coalescing or losing lifecycle changes.
export const fleetChangedNotificationSchema = fleetSnapshotSchema

// What a fleet surface calls the platform: the distribution for a daemon under
// WSL, since "linux" would not tell two of them apart, and the platform itself
// everywhere else.
export function machinePlatformLabel(
  machine: { platform: string; wsl?: MachineWslFacts | undefined },
): string {
  return machine.wsl ? `${machine.wsl.distribution} (WSL)` : machine.platform
}

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
export type MachineWslFacts = z.infer<typeof machineWslFactsSchema>
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
