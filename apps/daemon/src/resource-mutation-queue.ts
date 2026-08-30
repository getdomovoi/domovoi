export class ResourceMutationQueue {
  readonly #onError: (error: unknown) => void
  #barrier = Promise.resolve()
  #resources = new Map<string, Promise<void>>()
  #generation = 0
  #entries = new Set<{
    controller: AbortController
    generation: number
    onCancelled?: (reason: unknown) => void
  }>()

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
    const queued = Promise.all([barrier, previous])
      .then(() => this.#run(entry, task))
      .catch((error: unknown) => this.#onError(error))
    this.#resources.set(resource, queued)
    void queued.finally(() => {
      if (this.#resources.get(resource) === queued) this.#resources.delete(resource)
    })
    return queued
  }

  enqueueExclusive(
    task: (signal: AbortSignal) => Promise<void>,
    options: { onCancelled?: (reason: unknown) => void } = {},
  ): Promise<void> {
    const dependencies = [this.#barrier, ...this.#resources.values()]
    const entry = this.#entry(options.onCancelled)
    const queued = Promise.all(dependencies)
      .then(() => this.#run(entry, task))
      .catch((error: unknown) => this.#onError(error))
    this.#barrier = queued
    return queued
  }

  cancelAll(reason: unknown): number {
    this.#generation += 1
    const entries = [...this.#entries]
    for (const entry of entries) entry.controller.abort(reason)
    return entries.length
  }

  async drain(): Promise<void> {
    await Promise.all([this.#barrier, ...this.#resources.values()])
  }

  #entry(onCancelled?: (reason: unknown) => void) {
    const entry = {
      controller: new AbortController(),
      generation: this.#generation,
      ...(onCancelled ? { onCancelled } : {}),
    }
    this.#entries.add(entry)
    return entry
  }

  async #run(
    entry: {
      controller: AbortController
      generation: number
      onCancelled?: (reason: unknown) => void
    },
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      if (entry.generation !== this.#generation || entry.controller.signal.aborted) {
        entry.onCancelled?.(entry.controller.signal.reason)
        return
      }
      await task(entry.controller.signal)
    } catch (error) {
      if (entry.controller.signal.aborted) {
        entry.onCancelled?.(entry.controller.signal.reason)
        return
      }
      throw error
    } finally {
      this.#entries.delete(entry)
    }
  }
}
