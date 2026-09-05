import { chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export class ProfileAlreadyOwnedError extends Error {
  constructor(directory: string) {
    super(`Domovoi profile at ${directory} is already owned. Close Desktop or stop the running daemon, start the service, then reopen Desktop.`)
    this.name = "ProfileAlreadyOwnedError"
  }
}

export type ProfileLease = { release(): void }

// Losing a caller's handle is not evidence that its listener stopped. Retain
// the lease until explicit shutdown, never until JavaScript happens to collect it.
const heldLeases = new Set<DatabaseSync>()

export function claimProfile(homeDirectory: string): ProfileLease {
  const directory = join(homeDirectory, ".domovoi")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(directory, 0o700)

  // This is a separate, empty database, never the session store. The OS owns
  // its lifetime lock: process exit releases it without timestamps or PID
  // guesses. Never unlink the file, which would let another inode gain an
  // independent lock while the first owner is still running.
  const path = join(directory, "profile-lease.sqlite")
  const database = new DatabaseSync(path)
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600)
    // Contention refuses immediately. This must not synchronously wait on a
    // busy database while the daemon's event loop is responsible for progress.
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;")
  } catch (error) {
    database.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) throw new ProfileAlreadyOwnedError(directory)
    throw error
  }

  heldLeases.add(database)
  let released = false
  return {
    release: () => {
      if (released) return
      database.close()
      heldLeases.delete(database)
      released = true
    },
  }
}
