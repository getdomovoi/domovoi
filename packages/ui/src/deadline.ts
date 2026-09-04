// A deadline is the one clock an operation and every phase inside it share.
// It is started before any socket or request exists, so open, hello, and the
// answer all count against the same budget, and a phase that begins late gets
// only what is left rather than a fresh allowance.
export const maximumDeadlineMs = 2_147_483_647

export class DeadlineExceededError extends Error {
  readonly stage: string
  readonly target: string
  readonly budgetMs: number

  constructor(stage: string, target: string, budgetMs: number) {
    super(`Timed out after ${budgetMs}ms during ${stage} of ${target}`)
    this.name = "DeadlineExceededError"
    this.stage = stage
    this.target = target
    this.budgetMs = budgetMs
  }
}

export function deadlineBudget(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximumDeadlineMs) {
    throw new RangeError(`${label} must be between 1 and ${maximumDeadlineMs} milliseconds`)
  }
  return value
}

// Errors and events name where they were going, never the credential or query
// that may ride on the address.
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return "endpoint"
  }
}

export class Deadline {
  readonly budgetMs: number
  readonly #controller = new AbortController()
  readonly #startedAt: number
  readonly #now: () => number
  #timer: ReturnType<typeof setTimeout> | undefined
  #detachParent: (() => void) | undefined

  private constructor(budgetMs: number, now: () => number, parent?: Deadline) {
    this.budgetMs = budgetMs
    this.#now = now
    this.#startedAt = now()
    if (parent?.expired) {
      this.#controller.abort()
      return
    }
    if (parent) {
      const onParentExpired = () => this.#expire()
      parent.signal.addEventListener("abort", onParentExpired, { once: true })
      this.#detachParent = () => parent.signal.removeEventListener("abort", onParentExpired)
    }
    if (budgetMs <= 0) {
      this.#expire()
      return
    }
    this.#timer = setTimeout(() => this.#expire(), budgetMs)
  }

  static start(budgetMs: number, now: () => number = () => Date.now()): Deadline {
    return new Deadline(deadlineBudget(budgetMs, "Deadline budget"), now)
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get expired(): boolean {
    return this.#controller.signal.aborted
  }

  remainingMs(): number {
    if (this.expired) return 0
    return Math.max(0, this.budgetMs - (this.#now() - this.#startedAt))
  }

  // A phase may be held to less than the whole, never to more: the child ends
  // when its own budget runs out or when this deadline does, whichever is first.
  limit(budgetMs: number): Deadline {
    return new Deadline(
      Math.min(deadlineBudget(budgetMs, "Phase budget"), this.remainingMs()),
      this.#now,
      this,
    )
  }

  // Stops the clock once the operation has settled so nothing fires into work
  // that is already finished. Clearing never counts as expiry.
  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#detachParent?.()
    this.#detachParent = undefined
  }

  #expire(): void {
    this.clear()
    if (!this.#controller.signal.aborted) this.#controller.abort()
  }
}
