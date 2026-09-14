import { existsSync } from "node:fs"
import { join } from "node:path"
import { beforeDeadline, OperationDeadline, validateOperationDeadlineBudget } from "./operation-deadline.js"

const recoveryPhases = ["repository", "owner startup", "writer startup", "ancestry", "settlement", "restore"] as const
type RecoveryPhase = typeof recoveryPhases[number] | "cleanup" | "forced reap"

export function recoveryFixtureBudgets(phaseMs: number) {
  // Starting two runtimes and taking an OS ancestry snapshot are separate
  // operations. The holder must survive all six phases and failed-run cleanup.
  const sequenceMs = recoveryPhases.length * phaseMs
  const cleanupMs = phaseMs
  const reapMs = phaseMs
  const holderMs = sequenceMs + cleanupMs + reapMs
  return { phaseMs, sequenceMs, cleanupMs, reapMs, holderMs, testMs: holderMs + phaseMs }
}

export async function runRecoveryPhase<T>(
  phase: RecoveryPhase, sequence: OperationDeadline, budgetMs: number, operation: (deadline: OperationDeadline) => Promise<T>,
): Promise<T> {
  const deadline = sequence.limit(budgetMs)
  const started = performance.now()
  let settled = false
  console.info(JSON.stringify({ phase, event: "started", budgetMs }))
  try {
    deadline.throwIfExpired()
    const result = await beforeDeadline(operation(deadline), deadline)
    settled = true
    return result
  } catch (error) {
    throw new Error(`Workspace recovery fixture failed during ${phase} (${Math.round(performance.now() - started)}ms of ${budgetMs}ms phase budget)`, { cause: error })
  } finally {
    deadline.clear()
    console.info(JSON.stringify({ phase, event: settled ? "settled" : "failed", elapsedMs: Math.round(performance.now() - started) }))
  }
}

export function holdRecoveryWriter(root: string, timeoutMs: number, onExpired: () => void, onForced: () => void): () => void {
  validateOperationDeadlineBudget(timeoutMs)
  const stop = () => { clearTimeout(timeout); clearInterval(poll) }
  const timeout = setTimeout(() => { stop(); onExpired() }, timeoutMs)
  const poll = setInterval(() => {
    if (existsSync(join(root, "child-force-stop"))) { stop(); onForced() }
    else if (existsSync(join(root, "child-release"))) stop()
  }, 25)
  return stop
}

export async function waitForRecoveryCondition(deadline: OperationDeadline, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    deadline.throwIfExpired()
    if (await beforeDeadline(Promise.resolve().then(ready), deadline)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await beforeDeadline(new Promise<void>((resolve) => { timer = setTimeout(resolve, 25) }), deadline) }
    finally { clearTimeout(timer) }
  }
}

type RecoveryWriters = {
  pids: () => number[]
  isAlive: (pid: number) => boolean
  // Retained child handles or private fixture stop paths only. A PID probe
  // observes liveness, never ownership: the OS can reuse an exited writer's ID.
  forceStops: readonly (() => void)[]
  release: () => Promise<void>
  exited: Promise<unknown> | undefined
}

export async function cleanupRecoveryWriters(writers: RecoveryWriters, cleanupMs: number, reapMs: number): Promise<void> {
  const cleanup = OperationDeadline.start(cleanupMs)
  const failures: unknown[] = []
  const wait = async (deadline: OperationDeadline) => {
    await waitForRecoveryCondition(deadline, () => writers.pids().every((pid) => !writers.isAlive(pid)))
    if (writers.exited) await beforeDeadline(writers.exited, deadline)
  }
  try {
    await runRecoveryPhase("cleanup", cleanup, cleanupMs, async (deadline) => {
      await writers.release()
      await wait(deadline)
    })
  } catch (error) {
    failures.push(error)
  } finally { cleanup.clear() }
  if (failures.length === 0) return

  const reap = OperationDeadline.start(reapMs)
  try {
    for (const stop of writers.forceStops) {
      try { stop() } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error)
      }
    }
    await runRecoveryPhase("forced reap", reap, reapMs, wait)
  } catch (error) {
    failures.push(error)
  } finally { reap.clear() }
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, "Workspace recovery fixture cleanup failed", { cause: failures[0] })
}
