import { existsSync } from "node:fs"
import { join } from "node:path"
import { beforeDeadline, OperationDeadline, validateOperationDeadlineBudget } from "./operation-deadline.js"

const recoveryPhases = ["repository", "owner startup", "writer startup", "ancestry", "settlement", "restore"] as const
type RecoveryPhase = typeof recoveryPhases[number] | "cleanup"

export function recoveryFixtureBudgets(phaseMs: number) {
  // Starting two runtimes and taking an OS ancestry snapshot are separate
  // operations. The holder must survive all six phases and failed-run cleanup.
  const sequenceMs = recoveryPhases.length * phaseMs
  const cleanupMs = phaseMs
  const holderMs = sequenceMs + cleanupMs
  return { phaseMs, sequenceMs, cleanupMs, holderMs, testMs: holderMs + phaseMs }
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

export function holdRecoveryWriter(root: string, timeoutMs: number, onExpired: () => void): () => void {
  validateOperationDeadlineBudget(timeoutMs)
  const stop = () => { clearTimeout(timeout); clearInterval(poll) }
  const timeout = setTimeout(() => { stop(); onExpired() }, timeoutMs)
  const poll = setInterval(() => { if (existsSync(join(root, "child-release"))) stop() }, 25)
  return stop
}
