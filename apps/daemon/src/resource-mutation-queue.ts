type QueueEntry = {
  controller: AbortController
  generation: number
  started: boolean
  notified: boolean
  cancelled: Promise<void>
  resolveCancelled: () => void
  onCancelled?: (reason: unknown) => void
}

export class ResourceMutationQueue {
  readonly #onError: (error: unknown) => void
  #barrier = Promise.resolve()
  #resources = new Map<string, Promise<void>>()
  #generation = 0
  #entries = new Set<QueueEntry>()

  constructor(onError: (error: unknown) => void = () => {}) {
    this.#onError = onError
  }

  enqueue(
    resource: string,
    task: (signal: AbortSignal) => Promise<void>,
    options: { onCancelled?: (reason: unknown) => void } = {},
  ): Promise<void> {
    const barrier = this.#barrier
    const previous = this.#resources.get(resource) ?? Promise.resolve()
    const entry = this.#entry(options.onCancelled)
    const execution = Promise.all([barrier, previous])
      .then(() => this.#run(entry, task))
      .catch((error: unknown) => this.#onError(error))
    this.#resources.set(resource, execution)
    void execution.finally(() => {
      if (this.#resources.get(resource) === execution) this.#resources.delete(resource)
    })
    return Promise.race([execution, entry.cancelled])
  }

  enqueueExclusive(
    task: (signal: AbortSignal) => Promise<void>,
    options: { onCancelled?: (reason: unknown) => void } = {},
  ): Promise<void> {
    const dependencies = [this.#barrier, ...this.#resources.values()]
    const entry = this.#entry(options.onCancelled)
    const execution = Promise.all(dependencies)
      .then(() => this.#run(entry, task))
      .catch((error: unknown) => this.#onError(error))
    this.#barrier = execution
    return Promise.race([execution, entry.cancelled])
  }

  cancelAll(reason: unknown): { active: number; queued: number } {
    this.#generation += 1
    const entries = [...this.#entries]
    for (const entry of entries) {
      entry.controller.abort(reason)
      if (!entry.started) {
        this.#notifyCancelled(entry)
        this.#entries.delete(entry)
      }
      entry.resolveCancelled()
    }
    return {
      active: entries.filter(({ started }) => started).length,
      queued: entries.filter(({ started }) => !started).length,
    }
  }

  async drain(): Promise<void> {
    await Promise.all([this.#barrier, ...this.#resources.values()])
  }

  #entry(onCancelled?: (reason: unknown) => void) {
    let resolveCancelled = () => {}
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    const entry: QueueEntry = {
      controller: new AbortController(),
      generation: this.#generation,
      started: false,
      notified: false,
      cancelled,
      resolveCancelled,
      ...(onCancelled ? { onCancelled } : {}),
    }
    this.#entries.add(entry)
    return entry
  }

  async #run(
    entry: QueueEntry,
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      if (entry.generation !== this.#generation || entry.controller.signal.aborted) {
        this.#notifyCancelled(entry)
        return
      }
      entry.started = true
      await task(entry.controller.signal)
    } catch (error) {
      if (entry.controller.signal.aborted) {
        this.#notifyCancelled(entry)
        return
      }
      throw error
    } finally {
      this.#entries.delete(entry)
    }
  }

  #notifyCancelled(entry: QueueEntry): void {
    if (entry.notified) return
    entry.notified = true
    try {
      entry.onCancelled?.(entry.controller.signal.reason)
    } catch (error) {
      this.#onError(error)
    }
  }
}
