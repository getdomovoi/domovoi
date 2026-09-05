import { randomBytes, randomUUID } from "node:crypto"
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { credentialSchema } from "@getdomovoi/protocol"

import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"

const credentialReadAttempts = 20
const credentialReadDelayMs = 5
const credentialInitializationBudgetMs = 30_000

function malformedCredential(path: string): Error {
  return new Error(`Daemon credential is malformed at ${path}. Stop all Domovoi processes using this credential, move the file to a private quarantine directory, then restart. Existing credential bytes were not replaced.`)
}

async function readDaemonToken(path: string, deadline: OperationDeadline): Promise<string> {
  deadline.throwIfExpired()
  // Tighten legacy file permissions even when its bytes will be refused.
  // A partially written secret still belongs only to its owner.
  if (process.platform !== "win32") await chmod(path, 0o600)
  for (let attempt = 0; attempt < credentialReadAttempts; attempt += 1) {
    deadline.throwIfExpired()
    const token = (await readFile(path, { encoding: "utf8", signal: deadline.signal })).trim()
    deadline.throwIfExpired()
    if (credentialSchema.safeParse(token).success) return token
    if (token) throw malformedCredential(path)
    // Adopt a legacy writer that already created the final name. Never turn
    // an empty observation into permission to replace that writer's file.
    await delay(credentialReadDelayMs, undefined, { signal: deadline.signal })
  }
  throw malformedCredential(path)
}

export async function loadOrCreateDaemonToken(path: string, parent?: OperationDeadline): Promise<string> {
  const deadline = parent?.limit(credentialInitializationBudgetMs) ?? OperationDeadline.start(credentialInitializationBudgetMs)
  const staging = `${path}.${randomUUID()}.partial`
  let attemptedPublication = false
  let published = false
  let ownsStaging = false
  const initialize = async (): Promise<string> => {
    let failure: unknown
    let failed = false
    let token: string | undefined
    const cleanup: unknown[] = []
    try {
      deadline.throwIfExpired()
      const directory = dirname(path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      deadline.throwIfExpired()
      if (process.platform !== "win32") await chmod(directory, 0o700)
      try { token = await readDaemonToken(path, deadline) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (token === undefined) {
        deadline.throwIfExpired()
        const handle = await open(staging, "wx", 0o600)
        ownsStaging = true
        try {
          deadline.throwIfExpired()
          await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, { encoding: "utf8", signal: deadline.signal })
          deadline.throwIfExpired()
          await handle.sync()
          deadline.throwIfExpired()
        } catch (error) { failure = error; failed = true }
        // Closing and removing staging are independent. Never retry a close
        // whose outcome is unknown, and preserve an earlier write/sync error.
        try { await handle.close() } catch (error) { cleanup.push(error) }
        if (failed) throw failure
        if (cleanup.length) throw cleanup.shift()
        deadline.throwIfExpired()
        attemptedPublication = true
        try {
          // Only the final, fully written inode becomes authoritative. Copying
          // with EXCL would expose incomplete bytes again, so no fallback runs.
          await link(staging, path)
          published = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new Error(`Daemon credential filesystem cannot publish a complete file without replacement at ${path}. Use a filesystem that supports hard links.`, { cause: error })
          }
        }
        token = await readDaemonToken(path, deadline)
      }
      deadline.throwIfExpired()
    } catch (error) { failure = error; failed = true }
    finally {
      // A timeout bounds the caller, not uncancellable filesystem work. This
      // continuation may only close and remove its own unique staging file;
      // the checks above prevent a late write/sync from starting publication.
      if (ownsStaging) {
        try { await rm(staging, { force: true }) } catch (error) { cleanup.push(error) }
      }
    }
    if (cleanup.length) {
      throw new Error(`${published ? "Daemon credential publication completed" : "Daemon credential initialization failed"} at ${path}, but private staging cleanup failed at ${staging}. ${published ? "Reuse the published credential; do not rotate it." : "Inspect retained staging after stopping all Domovoi processes using this profile."}`, {
        cause: new AggregateError(failed ? [failure, ...cleanup] : cleanup),
      })
    }
    if (failed) throw failure
    return token!
  }
  try { return await beforeDeadline(initialize(), deadline) }
  catch (error) {
    if (deadline.signal.aborted) {
      throw new Error(`Daemon credential initialization timed out at ${path}. ${attemptedPublication ? "Publication may have completed; inspect and reuse a valid existing credential before retrying." : "No publication was started."} Private staging may remain at ${staging}; do not remove it while an initializer is still running.`, { cause: error })
    }
    throw error
  } finally { deadline.clear() }
}
