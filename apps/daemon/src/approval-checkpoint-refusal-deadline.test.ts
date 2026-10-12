import type * as FsPromises from "node:fs/promises"

import { afterEach, expect, it, vi } from "vitest"

// A filesystem that stops answering while the daemon looks for a lock. The
// deadline cannot cancel the stalled call, so the daemon starts no second
// lookup while one is still out: each refusal then says only that Git failed.
const stall = vi.hoisted(() => ({ on: false, calls: 0 }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const lstat = ((...args: Parameters<typeof actual.lstat>) => {
    if (!stall.on) return actual.lstat(...args)
    stall.calls += 1
    return new Promise(() => {})
  }) as typeof actual.lstat
  return { ...actual, lstat }
})

const { approvalCheckpointRefusal } = await import("./approval-checkpoint-refusal.js")

afterEach(() => {
  vi.useRealTimers()
})

it("stops looking at its deadline and starts no second lookup while one is stalled", async () => {
  vi.useFakeTimers()
  stall.on = true
  const stderr = "fatal: Unable to create '/repo/.git/index.lock': File exists.\n"
  const error = Object.assign(new Error(stderr), { code: 128, stderr })
  const gitFailed = { kind: "approval-checkpoint-refused", cause: "git-failed" }

  const first = approvalCheckpointRefusal(error, { timedOut: false, worktree: "/repo" })
  await vi.advanceTimersByTimeAsync(2_000)
  expect((await first).data).toEqual(gitFailed)
  expect(stall.calls).toBe(1)

  // No timer is advanced: the answer does not wait on the stalled lookup.
  expect((await approvalCheckpointRefusal(error, { timedOut: false, worktree: "/repo" })).data).toEqual(gitFailed)
  expect(stall.calls).toBe(1)
})
