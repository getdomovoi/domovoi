import type { OperationDeadline } from "../operation-deadline.js"

// The caller creates one deadline before any file or subprocess work. Racing
// bounds the caller even if an OS operation cannot abort; checking settlement
// prevents that late result from launching the next install step.
export function withinServiceDeadline<T>(deadline: OperationDeadline, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    deadline.throwIfExpired()
    const detach = () => deadline.signal.removeEventListener("abort", abort)
    const abort = () => { detach(); reject(deadline.signal.reason) }
    deadline.signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { deadline.throwIfExpired(); return operation() }).then((value) => {
      deadline.throwIfExpired()
      resolve(value)
    }).catch(reject).finally(detach)
  })
}
