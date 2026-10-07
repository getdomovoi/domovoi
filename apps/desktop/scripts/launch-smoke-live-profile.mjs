import { lstat } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"

// T24: a guard against a smoke reaching the real Domovoi profile. The smokes
// set HOME to a scratch directory, but the daemon's service-operation lease is
// placed under the account's passwd home on purpose, so HOME never moved it.
// This compares the real profile before and after a run. It only reads: a
// missing profile is recorded as missing and never created.
//
// Limits: it watches whether the profile directory exists and the lease's own
// files, the passwd-home write the smokes could reach. It does not watch the
// rest of the profile, which a Domovoi running on this machine writes in
// normal use (state.sqlite, profile-lease.sqlite and others).
const leaseFiles = ["", "-journal", "-wal", "-shm"].map(suffix => `service-operation-lease.sqlite${suffix}`)

export function liveProfileHome() {
  return userInfo().homedir
}

async function entry(path) {
  try {
    const found = await lstat(path, { bigint: true })
    // The lease chmods its file on every claim, which moves ctime even when
    // nothing is written and the mode stays the same.
    return [found.mode, found.ino, found.size, found.mtimeNs, found.ctimeNs].join(":")
  } catch (error) {
    if (error.code === "ENOENT") return "missing"
    throw error
  }
}

export async function liveProfileSnapshot(home = liveProfileHome()) {
  const profile = join(home, ".domovoi")
  const exists = (await entry(profile)) !== "missing"
  const snapshot = [[profile, exists ? "present" : "missing"]]
  for (const name of leaseFiles) snapshot.push([join(profile, name), exists ? await entry(join(profile, name)) : "missing"])
  return snapshot
}

// The paths whose state differs, in snapshot order.
export function liveProfileChanges(before, after) {
  const earlier = new Map(before)
  return after.filter(([path, state]) => earlier.get(path) !== state).map(([path]) => path)
}

export function liveProfileFailure(changed) {
  return `The smoke changed the real Domovoi profile: ${changed.join(", ")}. A smoke must not reach the passwd home's .domovoi.`
}
