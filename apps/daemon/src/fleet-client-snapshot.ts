import type { FleetSnapshot } from "@getdomovoi/protocol"

// Optional fields are not forward-compatible with an already shipped strict
// parser. Inspection is a per-request opt-in, not a sticky socket preference.
// Mutation results and fleet.changed retain the legacy shape. An inspecting
// client relists with the opt-in when a lifecycle notification arrives.
export function fleetClientSnapshot(snapshot: FleetSnapshot, includeQuarantined = false): FleetSnapshot {
  return includeQuarantined ? snapshot : { entries: snapshot.entries }
}
