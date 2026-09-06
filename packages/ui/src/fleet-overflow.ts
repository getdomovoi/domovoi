import {
  fleetSnapshotOverflowErrorCode,
  fleetSnapshotOverflowSchema,
  type FleetSnapshotOverflow,
} from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"

// The daemon withholds the whole list when its keychain holds more entries
// than the wire can carry; it never sends a shortened one. Only its own error
// code and typed data mean that. A message that happens to say "overflow"
// does not.
export function fleetListingOverflow(cause: unknown): FleetSnapshotOverflow | undefined {
  if (!(cause instanceof DaemonRpcError) || cause.code !== fleetSnapshotOverflowErrorCode) return undefined
  const parsed = fleetSnapshotOverflowSchema.safeParse(cause.data)
  return parsed.success ? parsed.data : undefined
}

export type FleetOverflowNotice = {
  title: string
  detail: string
  remedy: string
}

// The remedy is the daemon's local CLI, run where the keychain is. Wording
// matches apps/daemon/src/fleet-keychain-command.ts so the two never disagree
// about what removal does.
export function fleetOverflowNotice(overflow: FleetSnapshotOverflow): FleetOverflowNotice {
  return {
    title: "Fleet list withheld",
    detail: `The daemon's keychain holds ${overflow.totalEntries} fleet entries, more than the ${overflow.limit} this list can carry, so it returned none of them rather than a shortened list. ${overflow.entriesNotShown} entries are not shown. This is not an empty fleet.`,
    remedy: "On the daemon's own machine, run domovoid fleet-keychain list, then domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped for each entry you no longer need. Stop Domovoi and its supervisor first. Local removal does not revoke the credential on the target.",
  }
}
