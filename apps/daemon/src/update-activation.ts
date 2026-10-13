import { randomUUID } from "node:crypto"
import {
  activationJournalSchema, activationRuntimeSchema,
  type ActivationJournal, type ActivationRuntime,
} from "./update-state.js"

export type ActiveUpdateRuntime = { revision: string, runtime: ActivationRuntime }
export type ActivationHealth = {
  id: string, generation: string, runtime: ActivationRuntime,
  profileOwned: boolean, stateReady: boolean, listenerReady: boolean, healthy: boolean,
}
export type ActivationResult = {
  /** committed/rolled-back describe the recorded transaction, not current health. */
  state: "deferred" | "busy" | "committed" | "rolled-back" | "quarantined"
}

/** Acquire atomically with checking idle work; exclude new turns, approvals,
 * terminals, transfers and repository mutations until release. Every effect MUST
 * enforce its generation at mutation, not just entry. CAS includes revision to
 * distinguish A->B from A->C->A. Promise settlement guarantees no detached effect
 * can still land. On cancellation settle only after quiescence; otherwise the
 * fence stays held. No production implementation is supplied by this module.
 */
export interface ActivationFence {
  readonly generation: string
  assertHeld(): void
  release(): void
  readJournal(signal: AbortSignal): Promise<ActivationJournal | undefined>
  writeJournal(value: ActivationJournal, signal: AbortSignal): Promise<void>
  active(signal: AbortSignal): Promise<ActiveUpdateRuntime>
  /** Full immutable runtime verification, beyond receipt/lock identity checks. */
  verify(runtime: ActivationRuntime, signal: AbortSignal): Promise<boolean>
  /** Exact-target signing, D9 provenance and native activation/recovery evidence. */
  qualified(runtime: ActivationRuntime, signal: AbortSignal): Promise<boolean>
  switch(expected: ActiveUpdateRuntime, next: ActiveUpdateRuntime, signal: AbortSignal): Promise<void>
  /** Quiesce the attempted runtime before CAS, even if restoration already landed. */
  restore(expected: ActiveUpdateRuntime, next: ActiveUpdateRuntime, signal: AbortSignal): Promise<void>
  /** Launch at most once for this phase and await health or a settled failure. */
  start(journal: ActivationJournal, runtime: ActivationRuntime, signal: AbortSignal): Promise<ActivationHealth | undefined>
  /** Observe a prior launch without starting another process. */
  health(journal: ActivationJournal, runtime: ActivationRuntime, signal: AbortSignal): Promise<ActivationHealth | undefined>
}
export type ActivationOptions = {
  acquire(signal: AbortSignal): Promise<ActivationFence | undefined>
  /** Supplied policy, not a production timeout selected by this module. */
  timeoutMs: number
  startupTimeoutMs: number
  now?: () => number
}

function sameRuntime(a: ActivationRuntime, b: ActivationRuntime): boolean {
  return a.version === b.version && a.sha256 === b.sha256 && a.sourceCommit === b.sourceCommit
    && a.runtimeLockDigest === b.runtimeLockDigest && a.receiptDigest === b.receiptDigest && a.path === b.path
}
function sameActive(a: ActiveUpdateRuntime, b: ActiveUpdateRuntime): boolean {
  return a.revision === b.revision && sameRuntime(a.runtime, b.runtime)
}
function healthy(health: ActivationHealth | undefined, journal: ActivationJournal, runtime: ActivationRuntime): boolean {
  return !!health && health.id === journal.id && health.generation === journal.generation
    && sameRuntime(health.runtime, runtime) && health.profileOwned === true && health.stateReady === true
    && health.listenerReady === true && health.healthy === true
}

/** Isolated state machine. Public activation stays synchronous and deferred
 * until real qualification and supervisor adapters are approved.
 */
export class UpdateActivation {
  #busy = false
  constructor(readonly options: ActivationOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs <= 0 || options.startupTimeoutMs >= options.timeoutMs) {
      throw new Error("Activation requires a bounded timeout policy")
    }
  }
  activate(target: ActivationRuntime): Promise<ActivationResult> {
    return this.#run(activationRuntimeSchema.parse(target))
  }
  recover(): Promise<ActivationResult> { return this.#run() }

  async #run(target?: ActivationRuntime): Promise<ActivationResult> {
    if (this.#busy) return { state: "busy" }
    this.#busy = true
    let fence: ActivationFence | undefined
    let lastTime = -Infinity
    let deadline: number | undefined
    const abort = new AbortController()
    const check = () => {
      const now = (this.options.now ?? (() => performance.now()))()
      if (!Number.isFinite(now) || now < lastTime) throw new Error("Activation clock is invalid")
      lastTime = now
      deadline ??= now + this.options.timeoutMs
      if (!Number.isFinite(deadline) || now >= deadline || abort.signal.aborted) throw new Error("Activation deadline expired")
      fence?.assertHeld()
    }
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      check()
      const result = await operation()
      check()
      return result
    }
    const signal = abort.signal
    const launch = async (journal: ActivationJournal, runtime: ActivationRuntime) => {
      check()
      const startupDeadline = lastTime + this.options.startupTimeoutMs
      const watchdog = new AbortController()
      const timer = setTimeout(() => watchdog.abort(), this.options.startupTimeoutMs)
      try {
        // Cancellation requests shutdown; settlement proves it. Never restore
        // the old runtime while this launch could still produce a late effect.
        const result = await call(() => fence!.start(journal, runtime, AbortSignal.any([signal, watchdog.signal])))
        return watchdog.signal.aborted || lastTime >= startupDeadline ? undefined : result
      } finally { clearTimeout(timer) }
    }
    const write = async (journal: ActivationJournal, phase: ActivationJournal["phase"], newLaunch = false) => {
      const next = activationJournalSchema.parse({ ...journal, phase, ...(newLaunch ? { generation: fence!.generation } : {}) })
      await call(() => fence!.writeJournal(next, signal))
      return next
    }
    const rollback = async (journal: ActivationJournal): Promise<ActivationResult> => {
      const active = await call(() => fence!.active(signal))
      const next = { revision: journal.id, runtime: journal.target }
      const old = { revision: journal.previousRevision, runtime: journal.previous }
      const restored = { revision: journal.rollbackRevision, runtime: journal.previous }
      if (!sameActive(active, next) && !sameActive(active, old) && !sameActive(active, restored)) return { state: "quarantined" }
      if (await call(() => fence!.qualified(journal.previous, signal)) !== true
        || await call(() => fence!.verify(journal.previous, signal)) !== true) return { state: "quarantined" }
      if (journal.phase === "prepared" && sameActive(active, old)) {
        await write(journal, "rolled-back")
        return { state: "rolled-back" }
      }
      if (journal.phase === "restarting") {
        if (!sameActive(active, restored)) return { state: "quarantined" }
        const health = await call(() => fence!.health(journal, journal.previous, signal))
        if (!healthy(health, journal, journal.previous)) return { state: "quarantined" }
      } else {
        journal = await write(journal, "rollback")
        await call(() => fence!.restore(active, restored, signal))
        journal = await write(journal, "restarting", true)
        const health = await launch(journal, journal.previous)
        if (!healthy(health, journal, journal.previous)) return { state: "quarantined" }
      }
      await write(journal, "rolled-back")
      return { state: "rolled-back" }
    }
    const work = async (): Promise<ActivationResult> => {
      try {
        check()
        // Assign before cancellation checks so late acquisition is released.
        fence = await this.options.acquire(signal)
        check()
        if (!fence) return { state: "deferred" }
        const stored = await call(() => fence!.readJournal(signal))
        if (stored) {
          const journal = activationJournalSchema.parse(stored)
          if (journal.phase !== "committed" && journal.phase !== "rolled-back") return await rollback(journal)
          if (!target) return { state: journal.phase }
        } else if (!target) return { state: "deferred" }
        if (!target || await call(() => fence!.qualified(target, signal)) !== true) return { state: "deferred" }
        const active = await call(() => fence!.active(signal))
        const previous = activationRuntimeSchema.parse(active.runtime)
        if (sameRuntime(previous, target)) return { state: "deferred" }
        if (await call(() => fence!.qualified(previous, signal)) !== true) return { state: "deferred" }
        if (await call(() => fence!.verify(previous, signal)) !== true || await call(() => fence!.verify(target, signal)) !== true) return { state: "quarantined" }
        let journal = activationJournalSchema.parse({
          format: 1, id: randomUUID(), rollbackRevision: randomUUID(), generation: fence.generation,
          previousRevision: active.revision, previous, target, phase: "prepared",
        })
        journal = await write(journal, "prepared")
        await call(() => fence!.switch(active, { revision: journal.id, runtime: target }, signal))
        journal = await write(journal, "starting", true)
        let health: ActivationHealth | undefined
        try { health = await launch(journal, target) }
        catch { check(); return await rollback(journal) }
        if (!healthy(health, journal, target)) return await rollback(journal)
        await write(journal, "committed")
        return { state: "committed" }
      } catch {
        // An effect/publication may have landed. Recover from the durable
        // journal and actual active revision; never guess and replay it here.
        return { state: "quarantined" }
      } finally {
        try { fence?.release() } finally { this.#busy = false }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<ActivationResult>((resolve) => {
      timer = setTimeout(() => { abort.abort(); resolve({ state: "quarantined" }) }, this.options.timeoutMs)
    })
    // A timeout is ambiguous: report quarantine, then require explicit recovery
    // after settlement instead of racing automatic rollback with a late effect.
    // Bounded result, retained fence: work settles all effects before releasing.
    // Its next check prevents follow-up effects after timeout or ownership loss.
    const completion = work().finally(() => { if (timer) clearTimeout(timer) })
    return Promise.race([completion, expired])
  }
}
