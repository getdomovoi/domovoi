import { setTimeout as delay } from "node:timers/promises"

import type { OperationDeadline } from "../operation-deadline.js"
import type { ProfileLocation } from "../profile-directory.js"
import { ProfileAlreadyOwnedError, type ProfileLease } from "../profile-lease.js"
import { withinServiceDeadline } from "./deadline.js"

// How an update of the running service to a new runtime ended, when it did not
// end with the new service running. The words were approved 2026-09-23 and
// live only here.
export type DaemonServiceUpdateOutcome =
  | "not-installed"
  | "swap-failed-restored"
  | "swap-and-restore-failed"
  | "profile-taken-restored"

function detail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim().replace(/\.+$/u, "")
}

function updateMessage(outcome: DaemonServiceUpdateOutcome, cause: unknown, restoreCause: unknown): string {
  switch (outcome) {
    case "not-installed":
      return "No Domovoi service is installed for this user, so there is nothing to update. Install the service first."
    case "swap-failed-restored":
      return `Domovoi could not start the service on the new runtime: ${detail(cause)}. The previous service was put back and is running.`
    case "swap-and-restore-failed":
      return `Domovoi could not start the service on the new runtime: ${detail(cause)}. Putting the previous service back also failed: ${detail(restoreCause)}. The service is not running. Check it with \`domovoid service status\`, then install it again.`
    case "profile-taken-restored":
      return "Another Domovoi daemon took this profile while the service was stopped for the update. The previous service was put back and is running."
  }
}

export class DaemonServiceUpdateError extends Error {
  constructor(readonly outcome: DaemonServiceUpdateOutcome, cause?: unknown, readonly restoreCause?: unknown) {
    super(updateMessage(outcome, cause, restoreCause), cause === undefined ? undefined : { cause })
    this.name = "DaemonServiceUpdateError"
  }
}

// A swap step failed. Put the previous service back and say which way that
// went; a profile another daemon took is its own outcome.
export async function restoreAfterFailure(cause: unknown, restore: () => Promise<void>): Promise<never> {
  if (cause instanceof DaemonServiceUpdateError) throw cause
  try {
    await restore()
  } catch (restoreCause) {
    throw new DaemonServiceUpdateError("swap-and-restore-failed", cause, restoreCause)
  }
  throw new DaemonServiceUpdateError(cause instanceof ProfileAlreadyOwnedError ? "profile-taken-restored" : "swap-failed-restored", cause)
}

// The service was just stopped, and its daemon may take a moment to let the
// profile go. Wait for that, within a bound; still owned after it means
// another daemon holds the profile.
export async function claimProfileAfterStop(
  claim: (profile: ProfileLocation) => ProfileLease,
  profile: ProfileLocation,
  waitMs: number,
  deadline: OperationDeadline,
): Promise<ProfileLease> {
  const started = Date.now()
  for (;;) {
    try {
      return claim(profile)
    } catch (error) {
      if (!(error instanceof ProfileAlreadyOwnedError) || Date.now() - started >= waitMs) throw error
      await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal }))
    }
  }
}
