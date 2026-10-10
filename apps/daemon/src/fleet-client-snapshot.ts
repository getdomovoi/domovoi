import type { FleetSnapshot } from "@getdomovoi/protocol"

// Registry inspection remains a per-request opt-in from the 0.7 strict-parser
// contract, not a sticky socket preference. An inspecting client relists with
// the opt-in when a lifecycle notification arrives.
// daemonTime is safe unconditionally in 0.8: it is unreleased, so no shipped
// 0.8 strict parser exists, and version admission excludes 0.7 clients.
export function fleetClientSnapshot(snapshot: FleetSnapshot, includeQuarantined = false): FleetSnapshot {
  return {
    ...(includeQuarantined ? snapshot : { entries: snapshot.entries }),
    daemonTime: new Date(Date.now()).toISOString(),
  }
}
