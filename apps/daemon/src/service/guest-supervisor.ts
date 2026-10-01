import { randomUUID } from "node:crypto"

import { supervisorBackoffs, type GuestProcessIdentity, type SupervisorExit, type SupervisorRecord } from "./supervisor-record.js"

export type GuestExit = { code: number | null; signal: string | null }

// Ruling Q296 (2026-10-01, applying Q111 B: Windows orphans fail closed): a
// daemon's own exit does not prove that the agents, terminals and tools it
// started have ended. On Windows only a tree kill that succeeded proves it
// (supervisor-process.ts). Without that proof the loop does not restart, and
// records why, so status reports it and removal refuses. exit: the daemon's
// own exit, when a stop saw it.
export class ProcessTreeUnconfirmedError extends Error {
  constructor(reason: string, readonly exit?: GuestExit) {
    super(`The daemon's process tree could not be confirmed ended: ${reason}`)
    this.name = "ProcessTreeUnconfirmedError"
  }
}

// confirmTree: after the daemon exited on its own, resolves only once its
// process tree is known to have ended; absent where an exit says so (Linux).
export type GuestChild = { identity: GuestProcessIdentity; exited: Promise<GuestExit>; stop(): Promise<GuestExit>; confirmTree?(): Promise<void> }
// treeUnconfirmed: a process ran, briefly, and its tree was never ended.
export type GuestLaunch = { state: "started"; child: GuestChild } | { state: "failed"; errorCode: string; treeUnconfirmed?: true }
export type GuestSupervisorEffects = {
  now(): Date
  write(record: SupervisorRecord): void
  launch(): Promise<GuestLaunch>
  wait(ms: number, signal: AbortSignal): Promise<void>
}

export async function superviseGuest(input: {
  loop: GuestProcessIdentity; registrationId: string; configurationDigest: string; signal: AbortSignal
}, effects: GuestSupervisorEffects): Promise<SupervisorRecord> {
  const time = () => effects.now().toISOString()
  const began = time()
  const record: SupervisorRecord = {
    version: 1, supervisorId: randomUUID(), registrationId: input.registrationId, configurationDigest: input.configurationDigest,
    loop: input.loop, startedAt: began, updatedAt: began, state: "starting", attemptCount: 0, crashes: 0, attempts: [], reason: null,
  }
  const save = () => { record.updatedAt = time(); effects.write(structuredClone(record)) }
  const stopped = (kind: "clean-exit" | "deliberate-stop") => {
    record.state = "stopped"; record.reason = { kind, at: time() }; save(); return record
  }
  let child: GuestChild | undefined
  let stopAttempted = false
  try {
    // No launch until a readable ownership and policy record exists.
    save()
    for (;;) {
      if (input.signal.aborted) return stopped("deliberate-stop")
      const attempt: SupervisorRecord["attempts"][number] = {
        number: ++record.attemptCount, startedAt: time(), child: null, exit: null, backoffMs: 0,
        backoffEndedAt: null, backoffOutcome: null,
      }
      record.attempts.push(attempt)
      record.state = "starting"
      save()
      const launched = await effects.launch()
      let exit: SupervisorExit
      let unconfirmed = false
      if (launched.state === "failed") {
        exit = { kind: "launch-failed", code: null, signal: null, errorCode: launched.errorCode, at: time() }
        unconfirmed = launched.treeUnconfirmed === true
      } else {
        child = launched.child
        stopAttempted = false
        attempt.child = child.identity
        record.state = "running"
        save()
        let detach = () => {}
        const abort = new Promise<undefined>((resolve) => {
          const stop = () => resolve(undefined)
          input.signal.addEventListener("abort", stop, { once: true })
          detach = () => input.signal.removeEventListener("abort", stop)
          if (input.signal.aborted) stop()
        })
        let result: GuestExit | undefined
        try { result = await Promise.race([child.exited, abort]) } finally { detach() }
        if (result === undefined) {
          record.state = "stopping"; save()
          stopAttempted = true
          try {
            result = await child.stop()
          } catch (error) {
            // The daemon ended but its tree did not provably: recorded, not
            // thrown, so the record says why and removal refuses on it.
            if (!(error instanceof ProcessTreeUnconfirmedError) || error.exit === undefined) throw error
            result = error.exit
            unconfirmed = true
          }
        } else if (child.confirmTree !== undefined) {
          try {
            await child.confirmTree()
          } catch (error) {
            if (!(error instanceof ProcessTreeUnconfirmedError)) throw error
            unconfirmed = true
          }
        }
        child = undefined
        exit = { ...result, kind: input.signal.aborted ? "stopped" : result.code === 0 ? "clean" : "crash", errorCode: null, at: time() }
      }
      attempt.exit = exit
      if (unconfirmed) {
        if (exit.kind === "crash" || exit.kind === "launch-failed") ++record.crashes
        record.state = "failed"; record.reason = { kind: "tree-unconfirmed", at: time() }; save(); return record
      }
      if (exit.kind === "stopped") return stopped("deliberate-stop")
      if (exit.kind === "clean") return stopped("clean-exit")
      ++record.crashes
      if (input.signal.aborted) return stopped("deliberate-stop")
      const backoff = supervisorBackoffs[record.crashes - 1]
      if (backoff === undefined) {
        record.state = "exhausted"; record.reason = { kind: "restart-limit", at: time() }; save(); return record
      }
      attempt.backoffMs = backoff
      record.state = "backoff"
      save()
      try { await effects.wait(backoff, input.signal) } catch (error) {
        if (!input.signal.aborted) throw error
      }
      attempt.backoffEndedAt = time()
      attempt.backoffOutcome = input.signal.aborted ? "cancelled" : "completed"
      save()
    }
  } catch (error) {
    // An I/O or observation failure must never become another child attempt.
    if (child !== undefined && !stopAttempted) {
      const [cleanup] = await Promise.allSettled([child.stop()])
      if (cleanup.status === "rejected") {
        // Best effort: say so in the record too, so removal refuses on it.
        const last = record.attempts.at(-1)
        if (cleanup.reason instanceof ProcessTreeUnconfirmedError && cleanup.reason.exit !== undefined && last?.exit === null) {
          try {
            last.exit = { ...cleanup.reason.exit, kind: "stopped", errorCode: null, at: time() }
            record.state = "failed"; record.reason = { kind: "tree-unconfirmed", at: time() }; save()
          } catch { /* the original failure is the one reported */ }
        }
        throw new AggregateError([error, cleanup.reason], "Supervisor failure and child shutdown failure", { cause: error })
      }
    }
    throw error
  }
}
