import { renameSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

// Windows MoveFileEx refuses to replace a file that another process holds
// open: a desktop or CLI status read, a supervisor, or an antivirus scan of a
// file written moments earlier. Readers hold such files for milliseconds, so a
// replace retries EPERM, EACCES and EBUSY there for at most five seconds,
// waiting 5 ms and doubling to 250 ms. Elsewhere these codes are not sharing
// and fail at once, as does any other error on Windows. Only the rename is
// retried; the caller has already written and closed the staging file.
export const windowsSharingBudgetMs = 5_000
const sharingRefusals = new Set(["EPERM", "EACCES", "EBUSY"])
const firstPauseMs = 5
const pauseCapMs = 250

// The part of an operation deadline a replace honours: no rename starts and no
// wait runs past it.
export type ReplaceDeadline = { throwIfExpired(): void; remainingMs(): number }
export type FileReplacement = {
  platform: NodeJS.Platform
  rename(from: string, to: string): void
  // Blocks the caller. The default uses Atomics.wait.
  pause(ms: number): void
  now(): number
}
export type AsyncFileReplacement = {
  platform: NodeJS.Platform
  rename(from: string, to: string): void | Promise<void>
  pause(ms: number): Promise<void>
  now(): number
}
export type ReplaceOptions = {
  deadline?: ReplaceDeadline
  // Appended to the give-up message, for example what was not updated.
  consequence?: string
}

export class FileSharingError extends Error {
  readonly path: string
  readonly code: string
  constructor(path: string, code: string, consequence: string | undefined, cause: unknown) {
    super(`Could not replace ${path}: the file stayed held open by another process for ${windowsSharingBudgetMs / 1_000} s (Windows sharing refusal ${code}).${consequence ? ` ${consequence}` : ""}`, { cause })
    this.name = "FileSharingError"
    this.path = path
    this.code = code
  }
}

function sharingRetry(path: string, effects: { platform: NodeJS.Platform; now(): number }, options: ReplaceOptions) {
  const expiresAt = effects.now() + windowsSharingBudgetMs
  let pauseMs = firstPauseMs
  // Returns how long to wait before the next rename, or throws.
  return (error: unknown): number => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (effects.platform !== "win32" || typeof code !== "string" || !sharingRefusals.has(code)) throw error
    const remaining = expiresAt - effects.now()
    if (remaining <= 0) throw new FileSharingError(path, code, options.consequence, error)
    options.deadline?.throwIfExpired()
    const wait = Math.min(pauseMs, remaining, options.deadline?.remainingMs() ?? Infinity)
    pauseMs = Math.min(pauseMs * 2, pauseCapMs)
    return wait
  }
}

const blockFor = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Replace `path` with `staging` by rename, retrying a Windows sharing refusal.
// The wait is synchronous, for callers whose rename must not be queued behind
// other work; it blocks the event loop for at most the five second budget.
export function replaceFileSync(staging: string, path: string, replacement: Partial<FileReplacement> = {}, options: ReplaceOptions = {}): void {
  const effects: FileReplacement = {
    platform: replacement.platform ?? process.platform,
    rename: replacement.rename ?? renameSync,
    pause: replacement.pause ?? blockFor,
    now: replacement.now ?? (() => performance.now()),
  }
  const next = sharingRetry(path, effects, options)
  for (;;) {
    try { effects.rename(staging, path); return } catch (error) {
      effects.pause(next(error))
      options.deadline?.throwIfExpired()
    }
  }
}

// The same replace with an asynchronous wait. `rename` is required: the
// durable publish owns the one direct import of the promise rename.
export async function replaceFile(staging: string, path: string,
  replacement: Partial<AsyncFileReplacement> & Pick<AsyncFileReplacement, "rename">, options: ReplaceOptions = {}): Promise<void> {
  const effects: AsyncFileReplacement = {
    platform: replacement.platform ?? process.platform,
    rename: replacement.rename,
    pause: replacement.pause ?? ((ms) => delay(ms)),
    now: replacement.now ?? (() => performance.now()),
  }
  const next = sharingRetry(path, effects, options)
  for (;;) {
    try { await effects.rename(staging, path); return } catch (error) {
      await effects.pause(next(error))
      options.deadline?.throwIfExpired()
    }
  }
}
