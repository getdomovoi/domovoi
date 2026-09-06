import { setTimeout as delay } from "node:timers/promises"

// Removing a failed invocation's own unpublished staging gets this fresh
// budget, never the exhausted main deadline, so retries do not accumulate
// node_modules and caches. A removal that outlives it names the leftover path.
export const defaultCleanupTimeoutMs = 30_000

// A child the deadline aborted is killed but not yet reaped, and Windows
// refuses to remove a directory any surviving handle still holds. Retry inside
// the caller's cleanup budget instead of reporting a leftover tree.
const heldByAnExitingProcess = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

export async function removeStaging(staging, remove, cleanup) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await remove(staging, { recursive: true, force: true }) }
    catch (error) {
      if (!heldByAnExitingProcess.has(error?.code)) throw error
      cleanup.check()
      await delay(Math.min(20 * attempt, 200), undefined, { signal: cleanup.signal })
    }
  }
}

export function validateBootstrapTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Bootstrap timeout must be a positive integer at most 2147483647 ms")
  }
}

// Start before creating resources. Children can tighten, never extend, the
// original budget. Checking the clock at settlement also covers a busy loop
// that delays the timer. Uncancellable filesystem work may still finish late;
// callers must not begin another step after this rejects.
export function bootstrapDeadline(timeoutMs, message, parent) {
  validateBootstrapTimeout(timeoutMs)
  parent?.check()
  const expiresAt = performance.now() + timeoutMs
  const controller = new AbortController()
  const timeout = new Error(message)
  const abortFromParent = () => controller.abort(parent.signal.reason)
  parent?.signal.addEventListener("abort", abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
  const check = () => {
    parent?.check()
    if (performance.now() >= expiresAt) controller.abort(timeout)
    controller.signal.throwIfAborted()
  }
  return {
    signal: controller.signal,
    check,
    clear: () => {
      clearTimeout(timer)
      parent?.signal.removeEventListener("abort", abortFromParent)
    },
    run: (operation) => new Promise((resolve, reject) => {
      check()
      const detach = () => controller.signal.removeEventListener("abort", abort)
      const abort = () => { detach(); reject(controller.signal.reason) }
      controller.signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => { check(); return operation() }).then((value) => {
        check()
        resolve(value)
      }).catch(reject).finally(detach)
    }),
  }
}
