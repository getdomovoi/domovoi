import { fleetSnapshotOverflowErrorCode, fleetSnapshotOverflowSchema } from "@getdomovoi/protocol"

import { DaemonError } from "./lib/daemon"

// A withheld list is classified by the daemon's own code and typed data, never
// by its wording. The phone cannot run the daemon's CLI, so it says where the
// fix is rather than pretending the fleet is empty.
export function fleetProblem(cause: unknown): string {
  if (cause instanceof DaemonError && cause.code === fleetSnapshotOverflowErrorCode) {
    const overflow = fleetSnapshotOverflowSchema.safeParse(cause.data)
    if (overflow.success) {
      return `The daemon withheld the fleet list: its keychain holds ${overflow.data.totalEntries} entries, over the ${overflow.data.limit} the list can carry, and none are shown. This is not an empty fleet. The fix is on the daemon's machine: domovoid fleet-keychain list, then forget the entries no longer needed.`
    }
  }
  return cause instanceof Error ? cause.message : "The fleet could not be listed"
}
