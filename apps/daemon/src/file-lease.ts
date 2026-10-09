import { chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type FileLease = { release(): void }

// Losing a caller's handle is not proof that its work stopped. Retain the
// database until explicit release or process exit, never garbage collection.
const heldLeases = new Set<DatabaseSync>()

export function claimExclusiveFileLease(path: string, busy: () => Error): FileLease {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(directory, 0o700)

  // A separate, empty database, never the state store. Never unlink this file:
  // replacing its inode permits two independent locks at the same pathname.
  const database = new DatabaseSync(path)
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600)
    // Refuse contention immediately, without blocking the event loop.
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;")
  } catch (error) {
    database.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) throw busy()
    throw error
  }

  return retainLease(database)
}

export function claimSharedFileLease(path: string, busy: () => Error): FileLease | undefined {
  try { statSync(path) } catch (error) {
    // During the very first install, status may see half-written state without
    // a lease file. The next read is correct. Never create or unlink the lease.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }

  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    // BEGIN is deferred: the read acquires the shared lock until release.
    database.exec("PRAGMA busy_timeout = 0; BEGIN; SELECT count(*) FROM sqlite_master;")
  } catch (error) {
    database?.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) throw busy()
    throw error
  }
  return retainLease(database)
}

function retainLease(database: DatabaseSync): FileLease {
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
