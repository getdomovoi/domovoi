import { rm } from "node:fs/promises"

// Windows keeps a handle on a file for a short time after the process that used
// it exits, so removing a scratch directory immediately after a test fails with
// EBUSY or EPERM. Node retries those two codes for us when asked.
export const scratchRemovalRetries = 10
export const scratchRemovalRetryDelayMs = 50

export async function removeScratchDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: scratchRemovalRetries,
    retryDelay: scratchRemovalRetryDelayMs,
  })))
}
