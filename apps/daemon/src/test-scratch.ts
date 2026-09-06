import { rm, stat } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

export type ScratchRemoval =
  (path: string, options: { recursive: true; force: true }) => Promise<void>

// removeStaging in scripts/bootstrap-deadline.mjs refuses to abandon a tree an
// exiting child still holds, and retries exactly these codes. That module is an
// untyped script this package cannot import, so its refusal set and its linear
// backoff are mirrored here instead of being given different semantics.
const heldByAnExitingProcess = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

// Windows keeps a handle on a file for a short time after the process that used
// it exits, and on every platform a provider probe the daemon started under a
// scratch home can outlive the stop that ended it. Removal is bounded by these
// attempts, whose backoff sums to a few seconds.
export const scratchRemovalRetries = 25
export const scratchRemovalRetryDelayMs = 20
export const scratchRemovalMaximumDelayMs = 200

async function stillExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

// A resolved removal is not proof the tree is gone: a writer that outlived its
// stop can create it again a moment later. Absence from disk is the proof.
export async function removeScratchDirectory(
  path: string, remove: ScratchRemoval = rm,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let refusal: unknown
    try {
      await remove(path, { recursive: true, force: true })
      if (!await stillExists(path)) return
    } catch (error) {
      if (!heldByAnExitingProcess.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      refusal = error
    }
    if (attempt >= scratchRemovalRetries) {
      throw refusal ?? new Error(`Scratch directory was created again after removal: ${path}`)
    }
    await delay(Math.min(scratchRemovalRetryDelayMs * attempt, scratchRemovalMaximumDelayMs))
  }
}

// Every removal stands alone, so one failure never abandons the rest, and a
// path leaves the caller's list only once it is gone. Forgetting a directory
// before it was removed is what filled this machine's temporary filesystem.
export async function removeScratchDirectories(
  paths: string[], remove?: ScratchRemoval,
): Promise<void> {
  const attempts = await Promise.allSettled(paths.map(async (path) => {
    await removeScratchDirectory(path, remove)
    return path
  }))
  const removed = new Set<string>()
  const failures: unknown[] = []
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled") removed.add(attempt.value)
    else failures.push(attempt.reason)
  }
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    if (removed.has(paths[index]!)) paths.splice(index, 1)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not remove ${failures.length} scratch directories`)
  }
}
