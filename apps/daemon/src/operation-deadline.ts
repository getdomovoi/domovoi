// Every finite external operation starts its clock before creating resources.
// Fallback and phase limits share the original monotonic deadline; a phase
// cannot obtain a fresh allowance after an earlier phase spent the budget.
export const maximumOperationDeadlineMs = 2_147_483_647

export class OperationDeadlineExceededError extends Error {
  constructor() {
    super("The operation exceeded its deadline")
    this.name = "OperationDeadlineExceededError"
  }
}

type DeadlineScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const scheduler: DeadlineScheduler = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export function validateOperationDeadlineBudget(budgetMs: number): void {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > maximumOperationDeadlineMs) {
    throw new RangeError(`Deadline must be between 1 and ${maximumOperationDeadlineMs} milliseconds`)
  }
}

export class OperationDeadline {
  readonly #controller = new AbortController()
  readonly #expiresAt: number
  readonly #now: () => number
  readonly #scheduler: DeadlineScheduler
  #timer: unknown
  #detach: (() => void) | undefined

  private constructor(expiresAt: number, now: () => number, clock: DeadlineScheduler, signal?: AbortSignal) {
    this.#expiresAt = expiresAt
    this.#now = now
    this.#scheduler = clock
    if (signal) {
      const abort = () => this.#abort(signal.reason instanceof OperationDeadlineExceededError
        ? signal.reason : new Error("The operation was cancelled"))
      if (signal.aborted) { abort(); return }
      signal.addEventListener("abort", abort, { once: true })
      this.#detach = () => signal.removeEventListener("abort", abort)
    }
    const remaining = Math.max(0, expiresAt - now())
    if (remaining === 0) { this.#abort(new OperationDeadlineExceededError()); return }
    this.#timer = clock.setTimeout(() => this.#abort(new OperationDeadlineExceededError()), remaining)
  }

  static start(budgetMs: number, options: {
    signal?: AbortSignal
    now?: () => number
    scheduler?: DeadlineScheduler
  } = {}): OperationDeadline {
    validateOperationDeadlineBudget(budgetMs)
    const now = options.now ?? (() => performance.now())
    return new OperationDeadline(now() + budgetMs, now, options.scheduler ?? scheduler, options.signal)
  }

  get signal(): AbortSignal { return this.#controller.signal }

  remainingMs(): number {
    if (this.signal.aborted) return 0
    const remaining = Math.max(0, this.#expiresAt - this.#now())
    if (remaining === 0) this.#abort(new OperationDeadlineExceededError())
    return remaining
  }

  throwIfExpired(): void {
    this.remainingMs()
    if (this.signal.aborted) throw this.signal.reason
  }

  limit(budgetMs: number): OperationDeadline {
    validateOperationDeadlineBudget(budgetMs)
    this.remainingMs()
    return new OperationDeadline(
      Math.min(this.#expiresAt, this.#now() + budgetMs), this.#now, this.#scheduler, this.signal,
    )
  }

  clear(): void {
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer)
    this.#timer = undefined
    this.#detach?.()
    this.#detach = undefined
  }

  #abort(reason: Error): void {
    this.clear()
    if (!this.signal.aborted) this.#controller.abort(reason)
  }
}

// The caller must cancel resources or fence late side effects separately.
// Expiry bounds the wait, not an operation that ignores its AbortSignal.
export function beforeDeadline<T>(operation: Promise<T>, deadline: OperationDeadline): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(deadline.signal.reason)
    deadline.signal.addEventListener("abort", abort, { once: true })
    operation.then((value) => {
      try { deadline.throwIfExpired(); resolve(value) } catch (error) { reject(error) }
    }, reject).finally(() => deadline.signal.removeEventListener("abort", abort))
    try { deadline.throwIfExpired() } catch (error) {
      deadline.signal.removeEventListener("abort", abort)
      reject(error)
    }
  })
}
