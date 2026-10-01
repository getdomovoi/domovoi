import { randomUUID } from "node:crypto"

import { supervisorBackoffs, type GuestProcessIdentity, type SupervisorExit, type SupervisorRecord } from "./supervisor-record.js"

export type GuestExit = { code: number | null; signal: string | null }
export type GuestChild = { identity: GuestProcessIdentity; exited: Promise<GuestExit>; stop(): Promise<GuestExit> }
export type GuestLaunch = { state: "started"; child: GuestChild } | { state: "failed"; errorCode: string }
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
      if (launched.state === "failed") {
        exit = { kind: "launch-failed", code: null, signal: null, errorCode: launched.errorCode, at: time() }
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
          result = await child.stop()
        }
        child = undefined
        exit = { ...result, kind: input.signal.aborted ? "stopped" : result.code === 0 ? "clean" : "crash", errorCode: null, at: time() }
      }
      attempt.exit = exit
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
        throw new AggregateError([error, cleanup.reason], "Supervisor failure and child shutdown failure", { cause: error })
      }
    }
    throw error
  }
}
