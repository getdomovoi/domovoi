import { lstat } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"

// T24: a guard against a smoke reaching the real Domovoi profile. The smokes
// set HOME to a scratch directory, but the daemon's service-operation lease is
// placed under the account's passwd home on purpose, so HOME never moved it.
// This compares the real profile before and after a run. It only reads: a
// missing profile is recorded as missing and never created.
//
// What it sees of a lease claim (launch-smoke-args.node.mjs claims a real one):
// the profile directory appearing, which is all a fresh CI account shows; the
// lease file appearing; and, on macOS and Linux, the chmod to 0600 every claim
// makes of the lease file, which moves its change time. A rollback journal
// that comes and goes between the snapshots is not seen on its own, and on
// Windows a claim of a lease that already existed leaves nothing to see.
//
// Limits: the directory's own times are not compared, nor the rest of the
// profile, which a Domovoi running on this account writes in normal use
// (state.sqlite, profile-lease.sqlite and others). A Domovoi on this account
// that takes the service lease during the run (a status read from its
// Settings) fails the check as if the smoke had.
const leaseFiles = ["", "-journal", "-wal", "-shm"].map(suffix => `service-operation-lease.sqlite${suffix}`)

export function liveProfileHome() {
  return userInfo().homedir
}

async function entry(path, fields) {
  try {
    const found = await lstat(path, { bigint: true })
    return fields(found).join(":")
  } catch (error) {
    if (error.code === "ENOENT") return "missing"
    throw error
  }
}

export async function liveProfileSnapshot(home = liveProfileHome()) {
  const profile = join(home, ".domovoi")
  // The directory's mode only: a running daemon moves its times.
  const directory = await entry(profile, found => [found.mode])
  const snapshot = [[profile, directory]]
  for (const name of leaseFiles) {
    const path = join(profile, name)
    snapshot.push([path, directory === "missing" ? "missing" : await entry(path, found => [found.mode, found.ino, found.size, found.mtimeNs, found.ctimeNs])])
  }
  return snapshot
}

// The paths whose state differs, in snapshot order.
export function liveProfileChanges(before, after) {
  const earlier = new Map(before)
  return after.filter(([path, state]) => earlier.get(path) !== state).map(([path]) => path)
}

// The check after a run, as a message, or undefined when nothing changed. It
// never throws, so a runner can take it before its own cleanup and keep the
// error a failed run is already carrying.
export async function liveProfileVerdict(before, home = liveProfileHome()) {
  let after
  try {
    after = await liveProfileSnapshot(home)
  } catch (error) {
    return `The real Domovoi profile under ${home} could not be read after the smoke, so the run is not proven to have left it alone: ${error.message}`
  }
  const changed = liveProfileChanges(before, after)
  if (changed.length === 0) return undefined
  return `The real Domovoi profile changed during the smoke: ${changed.join(", ")}. A smoke must not reach the passwd home's .domovoi. `
    + "A Domovoi on this account that took its service lease during the run changes it too."
}
