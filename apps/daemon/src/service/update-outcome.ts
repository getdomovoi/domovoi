import { setTimeout as delay } from "node:timers/promises"

import type { LocalOwnerRecord } from "../local-owner-record.js"
import { OperationDeadline } from "../operation-deadline.js"
import type { ProfileLocation } from "../profile-directory.js"
import { ProfileAlreadyOwnedError, type ProfileLease } from "../profile-lease.js"
import { withinServiceDeadline } from "./deadline.js"
import type { claimServiceOperation } from "./operation-lease.js"

// How an update of the running service to a new runtime ended, when it did not
// end with the new service running. The words were approved 2026-09-23 and
// live only here.
export type DaemonServiceUpdateOutcome =
  | "not-installed"
  | "nothing-changed"
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
    case "nothing-changed":
      return `Domovoi could not update the service: ${detail(cause)}. Nothing was changed, and the service was left as it was.`
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

// The two halves of an update once everything it needs has been read: the
// swap to the new runtime, and the way back to what ran before.
export type ServiceSwap<T> = {
  swap: (deadline: OperationDeadline) => Promise<T>
  restore: (deadline: OperationDeadline) => Promise<void>
}

// Each half gets its own budget. The swap runs under one deadline; when any of
// its steps fails, a timeout included, the restore runs after it has ended,
// under a fresh deadline, so a swap that ran out of time is still put back.
// The service-operation lease is released on every path.
export async function runServiceUpdate<T>(
  claim: () => ReturnType<typeof claimServiceOperation>,
  budgetMs: number,
  prepare: (deadline: OperationDeadline) => Promise<ServiceSwap<T>>,
): Promise<T> {
  const lease = claim()
  try {
    const swapDeadline = OperationDeadline.start(budgetMs)
    try {
      // Reading what runs now changes nothing, so a failure there left the
      // service as it was (ruled 2026-09-23).
      let steps: ServiceSwap<T>
      try {
        steps = await prepare(swapDeadline)
      } catch (cause) {
        if (cause instanceof DaemonServiceUpdateError) throw cause
        throw new DaemonServiceUpdateError("nothing-changed", cause)
      }
      try {
        return await steps.swap(swapDeadline)
      } catch (cause) {
        if (cause instanceof DaemonServiceUpdateError) throw cause
        const restoreDeadline = OperationDeadline.start(budgetMs)
        try {
          await steps.restore(restoreDeadline)
        } catch (restoreCause) {
          throw new DaemonServiceUpdateError("swap-and-restore-failed", cause, restoreCause)
        } finally {
          restoreDeadline.clear()
        }
        throw new DaemonServiceUpdateError(cause instanceof ProfileAlreadyOwnedError ? "profile-taken-restored" : "swap-failed-restored", cause)
      }
    } finally {
      swapDeadline.clear()
    }
  } finally {
    lease.release()
  }
}

export type OwnerReader = (profile: ProfileLocation) => LocalOwnerRecord | undefined

function ownerOf(readOwner: OwnerReader, profile: ProfileLocation): LocalOwnerRecord | undefined {
  try {
    return readOwner(profile)
  } catch {
    // A record being rewritten, or not readable yet, says nothing either way.
    return undefined
  }
}

// The daemon instance that owns the profile now, if the owner record names
// one: the instance an update stops, and the one a new start must replace.
export function currentInstance(readOwner: OwnerReader, profile: ProfileLocation): string | undefined {
  const record = ownerOf(readOwner, profile)
  return record === undefined || record.state === "none" ? undefined : record.instanceId
}

function pause(waitMs: number, deadline: OperationDeadline): Promise<void> {
  return withinServiceDeadline(deadline, () => delay(Math.max(1, Math.min(200, waitMs)), undefined, { signal: deadline.signal }))
}

// The service was just stopped, and its daemon may take a moment to let the
// profile go. While the owner record still names that daemon, it is still
// shutting down; after the wait that is a failed stop, not a taken profile.
// Held by anything else after the wait, the profile was taken.
export async function claimProfileAfterStop(
  claim: (profile: ProfileLocation) => ProfileLease,
  readOwner: OwnerReader,
  profile: ProfileLocation,
  stoppedInstance: string | undefined,
  waitMs: number,
  deadline: OperationDeadline,
): Promise<ProfileLease> {
  const started = Date.now()
  for (;;) {
    try {
      return claim(profile)
    } catch (error) {
      if (!(error instanceof ProfileAlreadyOwnedError)) throw error
      if (Date.now() - started >= waitMs) {
        const stillStopping = stoppedInstance !== undefined && currentInstance(readOwner, profile) === stoppedInstance
        if (stillStopping) throw new Error(`the previous service did not let the profile go within ${Math.ceil(waitMs / 1000)} seconds`, { cause: error })
        throw error
      }
      await pause(waitMs, deadline)
    }
  }
}

// Started is not running: a runtime that fails at start leaves no service. The
// start counts once the owner record reports a daemon of this registration
// ready, as an instance other than the one there before the start.
export async function waitUntilReady(
  readOwner: OwnerReader,
  profile: ProfileLocation,
  registrationId: string | undefined,
  instanceBefore: string | undefined,
  waitMs: number,
  deadline: OperationDeadline,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const record = ownerOf(readOwner, profile)
    if (record?.state === "ready" && record.owner === "daemon" && record.instanceId !== instanceBefore
      && (registrationId === undefined || record.serviceRegistrationId === registrationId)) return
    if (Date.now() - started >= waitMs) throw new Error(`the service did not report ready within ${Math.ceil(waitMs / 1000)} seconds`)
    await pause(waitMs, deadline)
  }
}
