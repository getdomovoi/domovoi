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

// Ruled 2026-09-23: inside an update's texts, a profile another daemon holds
// is named in a few words. ProfileAlreadyOwnedError keeps its text elsewhere.
function briefly(cause: unknown): unknown {
  return cause instanceof ProfileAlreadyOwnedError ? new Error("another Domovoi daemon holds the profile", { cause }) : cause
}

export function seconds(ms: number): string {
  const count = Math.ceil(ms / 1000)
  return `${count} second${count === 1 ? "" : "s"}`
}

// The service-manager calls an update has started and not seen settle. A step
// that ran out of time may still be running; the restore waits for it, and
// the service lease is held until it settles.
export type InFlight = {
  settle: (waitMs: number) => Promise<boolean>
  settled: () => Promise<void>
}

export function trackInFlight<E extends object>(effects: E): { effects: E, inFlight: InFlight } {
  const pending = new Set<Promise<unknown>>()
  const tracked = { ...effects } as Record<string, unknown>
  for (const [key, value] of Object.entries(effects)) {
    if (typeof value !== "function") continue
    tracked[key] = (...args: unknown[]) => {
      const result: unknown = (value as (...parameters: unknown[]) => unknown).apply(effects, args)
      if (result instanceof Promise) {
        pending.add(result)
        void result.then(() => pending.delete(result), () => pending.delete(result))
      }
      return result
    }
  }
  const settled = async () => { while (pending.size > 0) await Promise.allSettled([...pending]) }
  return {
    effects: tracked as E,
    inFlight: {
      settled,
      settle: async (waitMs) => {
        if (pending.size === 0) return true
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), waitMs) })
        const done = await Promise.race([settled().then(() => true as const), expired])
        clearTimeout(timer)
        return done
      },
    },
  }
}

// How long a call that outlived its step may keep running before the restore
// starts anyway.
const inFlightWaitMs = 10_000

// The two halves of an update once everything it needs has been read: the
// swap to the new runtime, and the way back to what ran before.
export type ServiceSwap<T> = {
  swap: (deadline: OperationDeadline) => Promise<T>
  restore: (deadline: OperationDeadline) => Promise<void>
}

// Each half gets its own budget. The swap runs under one deadline; when any of
// its steps fails, a timeout included, the restore runs after the swap has
// ended and its calls have settled, under a fresh deadline, so a swap that ran
// out of time is still put back. The service-operation lease is released on
// every path, once no call the update started is still running.
export async function runServiceUpdate<T>(
  claim: () => ReturnType<typeof claimServiceOperation>,
  budgetMs: number,
  prepare: (deadline: OperationDeadline) => Promise<ServiceSwap<T>>,
  inFlight: InFlight,
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
        await inFlight.settle(inFlightWaitMs)
        const restoreDeadline = OperationDeadline.start(budgetMs)
        try {
          await steps.restore(restoreDeadline)
        } catch (restoreCause) {
          throw new DaemonServiceUpdateError("swap-and-restore-failed", briefly(cause), briefly(restoreCause))
        } finally {
          restoreDeadline.clear()
        }
        throw new DaemonServiceUpdateError(cause instanceof ProfileAlreadyOwnedError ? "profile-taken-restored" : "swap-failed-restored", cause)
      }
    } finally {
      swapDeadline.clear()
    }
  } finally {
    if (await inFlight.settle(inFlightWaitMs)) lease.release()
    else void inFlight.settled().finally(() => lease.release())
  }
}

export type OwnerReader = (profile: ProfileLocation) => LocalOwnerRecord | undefined

type OwnerRead = { ok: true, record: LocalOwnerRecord | undefined } | { ok: false }

function readOwnerOnce(readOwner: OwnerReader, profile: ProfileLocation): OwnerRead {
  try {
    return { ok: true, record: readOwner(profile) }
  } catch {
    // A record being rewritten, or not readable yet, says nothing either way.
    return { ok: false }
  }
}

function instanceOf(record: LocalOwnerRecord | undefined): string | undefined {
  return record === undefined || record.state === "none" ? undefined : record.instanceId
}

// The daemon instance that owns the profile now, if the owner record names
// one and can be read.
export function currentInstance(readOwner: OwnerReader, profile: ProfileLocation): string | undefined {
  const read = readOwnerOnce(readOwner, profile)
  return read.ok ? instanceOf(read.record) : undefined
}

function pause(waitMs: number, deadline: OperationDeadline): Promise<void> {
  return withinServiceDeadline(deadline, () => delay(Math.max(1, Math.min(200, waitMs)), undefined, { signal: deadline.signal }))
}

// Every daemon instance an update has seen in the owner record. A start counts
// only when a ready instance appears that is none of them, so neither the one
// that ran before the update, nor one a failed swap started, nor a record that
// could not be read at the moment of the start can pass for the new service.
export class OwnerInstances {
  readonly #seen = new Set<string>()

  constructor(readonly readOwner: OwnerReader, readonly profile: ProfileLocation) {}

  // Records whichever instance the owner record names now. A read that fails
  // is tried again briefly; what was seen before still counts either way.
  async note(deadline: OperationDeadline): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const read = readOwnerOnce(this.readOwner, this.profile)
      if (read.ok) {
        const instance = instanceOf(read.record)
        if (instance !== undefined) this.#seen.add(instance)
        return
      }
      await pause(50, deadline)
    }
  }

  // Started is not running: a runtime that fails at start leaves no service.
  // The start counts once the owner record reports a daemon of this
  // registration ready, as an instance not seen before.
  async waitUntilReady(registrationId: string | undefined, waitMs: number, deadline: OperationDeadline): Promise<void> {
    const started = Date.now()
    for (;;) {
      const read = readOwnerOnce(this.readOwner, this.profile)
      const record = read.ok ? read.record : undefined
      if (record?.state === "ready" && record.owner === "daemon" && !this.#seen.has(record.instanceId)
        && (registrationId === undefined || record.serviceRegistrationId === registrationId)) {
        this.#seen.add(record.instanceId)
        return
      }
      if (Date.now() - started >= waitMs) throw new Error(`the service did not report ready within ${seconds(waitMs)}`)
      await pause(waitMs, deadline)
    }
  }
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
        if (stillStopping) throw new Error(`the previous service did not let the profile go within ${seconds(waitMs)}`, { cause: error })
        throw error
      }
      await pause(waitMs, deadline)
    }
  }
}

// Polls until the condition holds or the wait runs out; says which.
export async function within(waitMs: number, deadline: OperationDeadline, condition: () => Promise<boolean>): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (await condition()) return true
    if (Date.now() - started >= waitMs) return false
    await pause(waitMs, deadline)
  }
}
