import { describe, expect, it, vi } from "vitest"

import { ResourceMutationQueue } from "./resource-mutation-queue.js"

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve: () => resolve!() }
}

describe("ResourceMutationQueue", () => {
  it("aborts running work, rejects queued work, and admits a fresh generation", async () => {
    const queue = new ResourceMutationQueue()
    const running = deferred()
    const started = deferred()
    const cancelled = vi.fn()
    const queued = vi.fn(async () => {})

    const active = queue.enqueue("session-a", async () => {
      started.resolve()
      await running.promise
    })
    await started.promise
    const waiting = queue.enqueue("session-a", queued, { onCancelled: cancelled })

    expect(queue.cancelAll(new Error("Emergency stop requested"))).toEqual({
      active: 1,
      queued: 1,
    })
    expect(queued).not.toHaveBeenCalled()
    await expect(Promise.race([
      waiting.then(() => "cancelled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("cancelled")
    expect(cancelled).toHaveBeenCalledOnce()
    expect(queue.cancelAll(new Error("Repeated emergency stop"))).toEqual({
      active: 1,
      queued: 0,
    })

    const fresh = vi.fn(async () => {})
    await queue.enqueue("session-a", fresh)
    expect(fresh).toHaveBeenCalledOnce()

    running.resolve()
    await Promise.all([active, waiting])
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it("keeps mutations ordered within one resource", async () => {
    const queue = new ResourceMutationQueue()
    const first = deferred()
    const order: string[] = []

    const firstTask = queue.enqueue("session-a", async () => {
      order.push("first:start")
      await first.promise
      order.push("first:end")
    })
    const secondTask = queue.enqueue("session-a", async () => {
      order.push("second")
    })
    await vi.waitFor(() => expect(order).toEqual(["first:start"]))

    first.resolve()
    await Promise.all([firstTask, secondTask])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  it("continues cancelling when one cancellation callback fails", async () => {
    const errors: unknown[] = []
    const queue = new ResourceMutationQueue((error) => errors.push(error))
    const first = queue.enqueue("first", async () => {}, {
      onCancelled: () => { throw new Error("closed client") },
    })
    const secondCancelled = vi.fn()
    const second = queue.enqueue("second", async () => {}, { onCancelled: secondCancelled })

    expect(() => queue.cancelAll(new Error("Emergency stop requested"))).not.toThrow()
    await Promise.all([first, second])
    expect(secondCancelled).toHaveBeenCalledOnce()
    expect(errors).toEqual([expect.objectContaining({ message: "closed client" })])
  })

  it("runs unrelated resources concurrently", async () => {
    const queue = new ResourceMutationQueue()
    const first = deferred()
    const order: string[] = []

    const blocked = queue.enqueue("session-a", async () => {
      order.push("a:start")
      await first.promise
      order.push("a:end")
    })
    const independent = queue.enqueue("session-b", async () => {
      order.push("b")
    })

    await independent
    expect(order).toEqual(["a:start", "b"])
    first.resolve()
    await blocked
  })

  it("uses exclusive mutations as barriers for every resource", async () => {
    const queue = new ResourceMutationQueue()
    const first = deferred()
    const exclusive = deferred()
    const order: string[] = []

    const beforeBarrier = queue.enqueue("session-a", async () => {
      order.push("session:start")
      await first.promise
      order.push("session:end")
    })
    const barrier = queue.enqueueExclusive(async () => {
      order.push("exclusive:start")
      await exclusive.promise
      order.push("exclusive:end")
    })
    const afterBarrier = queue.enqueue("session-b", async () => {
      order.push("after")
    })
    await vi.waitFor(() => expect(order).toEqual(["session:start"]))

    first.resolve()
    await vi.waitFor(() => expect(order).toEqual([
      "session:start",
      "session:end",
      "exclusive:start",
    ]))
    exclusive.resolve()
    await Promise.all([beforeBarrier, barrier, afterBarrier])
    expect(order).toEqual([
      "session:start",
      "session:end",
      "exclusive:start",
      "exclusive:end",
      "after",
    ])
  })

  it("does not poison a resource after a failed mutation", async () => {
    const onError = vi.fn()
    const queue = new ResourceMutationQueue(onError)
    await queue.enqueue("session-a", async () => { throw new Error("failed") })
    const next = vi.fn(async () => {})

    await queue.enqueue("session-a", next)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "failed" }))
    expect(next).toHaveBeenCalledOnce()
  })
})
