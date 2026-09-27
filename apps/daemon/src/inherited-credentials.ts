import { realpathSync, statSync, type BigIntStats } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { configuredProfileDirectory, profileDirectory, profileLocation } from "./profile-directory.js"

// A launcher can hand this process the daemon bearer and its credential path
// through DOMOVOI_AUTH_TOKEN and DOMOVOI_CREDENTIAL_PATH. Every provider, agent
// server and terminal the daemon starts inherits process.env, and the bearer
// resolves approvals, so the values are taken out of process.env the first time
// they are read and kept here. A later acquisition in the same process, such as
// the desktop reacquiring its daemon, gets the same values back instead of
// falling through to a different credential.
//
// The kept values belong to the profile directory the process environment
// named when it carried them, pinned at that moment by device, inode and
// canonical path. A profile path that later leads somewhere else, such as a
// retargeted symlink, is another profile, and so is a directory at another
// path that reports the same device and inode, as a new directory can when a
// filesystem such as ext4 gives it the inode number of one just deleted. A
// directory that does not exist yet is pinned by its canonical path until it
// first matches, then by device, inode and canonical path. Only a
// later read of process.env itself for the same profile gets the values back.
// Another profile loads its own credential, and an environment the caller
// built itself is read as given.

const inheritedNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE"] as const

type ProfileIdentity =
  | { kind: "inode"; dev: bigint; ino: bigint; path: string }
  | { kind: "path"; path: string }

type KeptCredentials = {
  identity: ProfileIdentity
  values: Partial<Record<(typeof inheritedNames)[number], string>>
}

const kept: KeptCredentials[] = []

// Test-only. Each test file shares this module across its tests, and a test
// that deletes its profile directory would otherwise leave an entry pinned to
// a directory that no longer exists.
export function resetKeptCredentialsForTests(): void {
  kept.length = 0
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

// A directory that does not exist yet is named by the canonical path of its
// nearest existing ancestor with the rest appended.
function canonicalMissingPath(directory: string): string {
  const missing: string[] = []
  let at = resolve(directory)
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing.reverse())
    } catch (error) {
      const parent = dirname(at)
      if (!isMissing(error) || parent === at) throw error
      missing.push(basename(at))
      at = parent
    }
  }
}

// Undefined when the profile cannot be named: an invalid DOMOVOI_PROFILE_DIR,
// a symlink loop, an unreadable path, or a directory that exists but whose
// canonical path cannot then be read or leads to another directory. Nothing
// is kept for it or filled into it, and the settings parse or the profile
// claim reports the problem.
function profileIdentity(profileSetting: string | undefined, homeDirectory: string): ProfileIdentity | undefined {
  try {
    const directory = profileDirectory(profileLocation(homeDirectory, configuredProfileDirectory(profileSetting, homeDirectory)))
    // Birth time is not part of the identity. Where statx is unavailable,
    // libuv reports the change time as birth time, and the change time moves
    // whenever a file is added to the directory, so the daemon writing its own
    // credential would make the profile stop matching itself.
    let stats: BigIntStats
    try {
      stats = statSync(directory, { bigint: true })
    } catch (error) {
      if (!isMissing(error)) return undefined
      return { kind: "path", path: canonicalMissingPath(directory) }
    }
    // The directory exists, so a canonical path that cannot be read, even with
    // ENOENT, is not a missing profile. It throws to the outer catch and the
    // profile gets nothing, rather than matching a bearer pinned by path.
    const path = realpathSync.native(directory)
    // A symlink retargeted between the stat and the lookup would pair one
    // directory's inode with another's path, and the same switch later would
    // match that pair. The canonical path must lead to the directory the stat
    // saw; if it does not, or cannot be read, the profile is not named.
    const resolved = statSync(path, { bigint: true })
    if (resolved.dev !== stats.dev || resolved.ino !== stats.ino) return undefined
    return { kind: "inode", dev: stats.dev, ino: stats.ino, path }
  } catch {
    return undefined
  }
}

function sameIdentity(left: ProfileIdentity, right: ProfileIdentity): boolean {
  if (left.kind === "inode" && right.kind === "inode") return left.dev === right.dev && left.ino === right.ino && left.path === right.path
  return left.kind === "path" && right.kind === "path" && left.path === right.path
}

export type InheritedCredentialValues = Readonly<Partial<Record<(typeof inheritedNames)[number], string>>>

// The first statement of every acquisition, before its arguments are checked:
// the values leave process.env before anything else can throw, so no failure
// leaves them for a child or a later acquisition to inherit. They are pinned to
// the profile process.env names, the one they were handed for; an unusable
// home directory or profile setting keeps nothing.
// The home directory is passed as a function, called only after the scrub, so
// an entry point hands over its options unread: a getter that throws cannot
// run before the values are out of process.env.
//
// held: values a caller already took out of process.env and kept in memory
// until this module loaded (the desktop, whose daemon loads at run time from
// the runtime it ships; owner ruling 2026-09-26 on #577). They are pinned here
// exactly as values read from process.env are, and a held value wins over one
// still in process.env. Limit: the profile is pinned when this call runs, at
// daemon load, not when the caller took the values; a DOMOVOI_PROFILE_DIR
// retargeted in between is the profile they are pinned to.
export function captureInheritedCredentials(homeDirectory: () => unknown, held: InheritedCredentialValues = {}): void {
  const values: KeptCredentials["values"] = {}
  for (const name of inheritedNames) {
    const value = Object.hasOwn(held, name) ? held[name] : process.env[name]
    if (value !== undefined && value !== "") values[name] = value
    delete process.env[name]
  }
  if (Object.keys(values).length === 0) return
  let home: string
  try {
    const given = homeDirectory()
    home = resolve(typeof given === "string" ? given : homedir())
  } catch {
    return
  }
  const identity = profileIdentity(process.env.DOMOVOI_PROFILE_DIR, home)
  if (identity === undefined) return
  const existing = kept.find((entry) => sameIdentity(entry.identity, identity))
  if (existing) existing.values = values
  else kept.push({ identity, values })
}

// The kept entry for the profile the environment names now. An entry pinned
// by path, for a directory that did not exist when it was kept, matches the
// directory now at that canonical path and is pinned to it from then on.
function keptFor(environment: NodeJS.ProcessEnv, homeDirectory: string): KeptCredentials | undefined {
  const identity = profileIdentity(environment.DOMOVOI_PROFILE_DIR, homeDirectory)
  if (identity === undefined) return undefined
  const entry = kept.find((candidate) => sameIdentity(candidate.identity, identity))
  if (entry || identity.kind !== "inode") return entry
  const pending = kept.find((candidate) => candidate.identity.kind === "path" && candidate.identity.path === identity.path)
  if (pending) pending.identity = identity
  return pending
}

// Overrides carry settings, never credentials. A bearer or a credential file
// named in them would configure whatever profile they select with it, so an
// override that sets one is refused before anything starts.
const credentialSettings = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE"] as const

export function refuseCredentialOverrides(overrides: Readonly<Record<string, string>> | undefined): void {
  for (const name of credentialSettings) {
    if (overrides !== undefined && Object.hasOwn(overrides, name)) throw new Error(`environmentOverrides cannot set ${name}`)
  }
}

// The environment to read settings from, with the overrides applied. When the
// environment is process.env itself, it gets back the bearer and path kept for
// the profile the acquisition ends up with, after the overrides: an override
// naming another profile gets nothing of this one's. Any other environment is
// returned as given.
export function withInheritedCredentials(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  captureInheritedCredentials(() => homeDirectory)
  refuseCredentialOverrides(overrides)
  const filled: NodeJS.ProcessEnv = { ...environment, ...overrides }
  if (environment !== process.env) return filled
  const entry = keptFor(filled, homeDirectory)
  if (!entry) return filled
  for (const name of inheritedNames) {
    const value = entry.values[name]
    if (value !== undefined) filled[name] = value
  }
  return filled
}

// The same environment for anything that is not reading settings, with the
// bearer and path removed even from a copy taken before they were scrubbed.
export function withoutInheritedCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = { ...environment }
  for (const name of inheritedNames) delete stripped[name]
  return stripped
}
