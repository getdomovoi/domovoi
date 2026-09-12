import { setTimeout as delay } from "node:timers/promises"

import { OperationDeadline } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"

export function wslTaskFixtureBudgets(phase?: string): {
  phase: number; lifecycle: number; diagnostics: number; cleanup: number; test: number
} {
  const text = phase ?? "300000"
  const milliseconds = Number(text)
  // Refuse before registering a task. Reserve cleanup and runner startup/
  // reporting time; a shorter outer phase must not kill Vitest's finally.
  // The minimum leaves 120 seconds for a lifecycle with a 60-second retry.
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(milliseconds)
    || milliseconds < 180_000 || milliseconds > 600_000) {
    throw new Error("WSL service phase budget must be an integer from 180000 through 600000 ms")
  }
  const cleanup = 30_000
  const lifecycle = milliseconds - cleanup - 30_000
  // Diagnostics get a fresh deadline after lifecycle expiry. Spend ten seconds
  // of the runner margin, without extending startup or borrowing from cleanup.
  const diagnostics = 10_000
  return { phase: milliseconds, lifecycle, diagnostics, cleanup, test: lifecycle + diagnostics + cleanup + 1_000 }
}

type ReadinessRecord = Record<string, unknown>

export async function observeWslTaskReadiness<T>(options: {
  deadline: OperationDeadline
  diagnosticsMs: number
  start?: () => Promise<string>
  task: (active: OperationDeadline) => Promise<{ state: number; lastTaskResult: number }>
  probe: (report: (entry: ReadinessRecord) => void) => Promise<T | undefined>
  snapshot: (active: OperationDeadline) => Promise<unknown>
  record: (entry: ReadinessRecord) => void
}): Promise<T> {
  const { deadline, record } = options
  const began = performance.now()
  const emit = (entry: ReadinessRecord) => record({ elapsedMs: Math.round(performance.now() - began),
    remainingMs: deadline.remainingMs(), ...entry })
  try {
    if (options.start) {
      emit({ event: "start", state: "requested" })
      const result = await withinServiceDeadline(deadline, options.start)
      emit({ event: "start", state: "returned", result })
    }
    for (let poll = 1; ; poll++) {
      deadline.throwIfExpired()
      // Emit before awaiting too: a hung COM query must leave a named last step.
      emit({ event: "task-query", poll })
      const task = await withinServiceDeadline(deadline, () => options.task(deadline))
      emit({ event: "task", poll, ...task })
      const value = await withinServiceDeadline(deadline,
        () => options.probe((entry) => emit({ event: "guest", poll, ...entry })))
      if (value !== undefined) return value
      await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal }))
    }
  } catch (error) {
    // The expired lifecycle cannot collect evidence. Both independent reads
    // share one fresh, bounded allowance; either can fail without hiding the other.
    const diagnostics = OperationDeadline.start(options.diagnosticsMs)
    try {
      emit({ event: "failure-diagnostics-start", budgetMs: options.diagnosticsMs })
      const [task, guest] = await Promise.allSettled([
        withinServiceDeadline(diagnostics, () => options.task(diagnostics)),
        withinServiceDeadline(diagnostics, () => options.snapshot(diagnostics)),
      ])
      const result = (value: PromiseSettledResult<unknown>) => value.status === "fulfilled"
        ? { value: value.value } : { error: String(value.reason).slice(0, 4_096) }
      emit({ event: "failure-diagnostics", task: result(task), guest: result(guest) })
    } finally { diagnostics.clear() }
    throw error
  }
}

// The fixture owns this home. Capture only readiness sidecars, never arbitrary
// profile files. Bounded text preserves partial or malformed JSON.
export const wslGuestReadinessSnapshotScript = [
  "const fs = require('node:fs'), path = require('node:path');",
  "const snapshot = {};",
  "for (const file of ['process.json', 'process.partial', '.domovoi/local-owner.json']) {",
  "  let descriptor;",
  "  try {",
  "    descriptor = fs.openSync(path.join(process.argv[1], file), 'r');",
  "    const stat = fs.fstatSync(descriptor);",
  "    if (!stat.isFile()) throw Object.assign(new Error('Sidecar is not a regular file'), { code: 'ENOTFILE' });",
  "    const buffer = Buffer.alloc(4096);",
  "    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);",
  "    snapshot[file] = { state: 'present', content: buffer.subarray(0, bytes).toString('utf8'), bytes, truncated: stat.size > bytes };",
  "  } catch (error) {",
  "    snapshot[file] = error.code === 'ENOENT' ? { state: 'missing' }",
  "      : { state: 'error', code: String(error.code), message: String(error.message).slice(0, 1024) };",
  "  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }",
  "}",
  "process.stdout.write(JSON.stringify(snapshot));",
].join("\n")
