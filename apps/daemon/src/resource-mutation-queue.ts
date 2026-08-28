export class ResourceMutationQueue {
  readonly #onError: (error: unknown) => void
  #barrier = Promise.resolve()
  #resources = new Map<string, Promise<void>>()

  constructor(onError: (error: unknown) => void = () => {}) {
    this.#onError = onError
  }

  enqueue(resource: string, task: () => Promise<void>): Promise<void> {
    const barrier = this.#barrier
    const previous = this.#resources.get(resource) ?? Promise.resolve()
    const queued = Promise.all([barrier, previous])
      .then(task)
      .catch((error: unknown) => this.#onError(error))
    this.#resources.set(resource, queued)
    void queued.finally(() => {
      if (this.#resources.get(resource) === queued) this.#resources.delete(resource)
    })
    return queued
  }

  enqueueExclusive(task: () => Promise<void>): Promise<void> {
    const dependencies = [this.#barrier, ...this.#resources.values()]
    const queued = Promise.all(dependencies)
      .then(task)
      .catch((error: unknown) => this.#onError(error))
    this.#barrier = queued
    return queued
  }

  async drain(): Promise<void> {
    await Promise.all([this.#barrier, ...this.#resources.values()])
  }
}
