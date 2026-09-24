import { realpathSync, statSync } from "node:fs"
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
// named when it carried them, pinned at that moment by device and inode. A
// profile path that later leads somewhere else, such as a retargeted symlink,
// is another profile. A directory that does not exist yet is pinned by its
// canonical path until it first matches, then by device and inode. Only a
// later read of process.env itself for the same profile gets the values back.
// Another profile loads its own credential, and an environment the caller
// built itself is read as given.

const inheritedNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH"] as const

type ProfileIdentity =
  | { kind: "inode"; dev: bigint; ino: bigint }
  | { kind: "path"; path: string }

type KeptCredentials = {
  identity: ProfileIdentity
  values: Partial<Record<(typeof inheritedNames)[number], string>>
}

const kept: KeptCredentials[] = []

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
// a symlink loop or an unreadable path. Nothing is kept for it or filled into
// it, and the settings parse or the profile claim reports the problem.
function profileIdentity(profileSetting: string | undefined, homeDirectory: string): ProfileIdentity | undefined {
  try {
    const directory = profileDirectory(profileLocation(homeDirectory, configuredProfileDirectory(profileSetting, homeDirectory)))
    try {
      const stats = statSync(directory, { bigint: true })
      return { kind: "inode", dev: stats.dev, ino: stats.ino }
    } catch (error) {
      if (!isMissing(error)) return undefined
      return { kind: "path", path: canonicalMissingPath(directory) }
    }
  } catch {
    return undefined
  }
}

function sameIdentity(left: ProfileIdentity, right: ProfileIdentity): boolean {
  if (left.kind === "inode" && right.kind === "inode") return left.dev === right.dev && left.ino === right.ino
  return left.kind === "path" && right.kind === "path" && left.path === right.path
}

// The first statement of every acquisition, before its arguments are checked:
// the values leave process.env before anything else can throw, so no failure
// leaves them for a child or a later acquisition to inherit. They are pinned to
// the profile process.env names, the one they were handed for; an unusable
// home directory or profile setting keeps nothing.
export function captureInheritedCredentials(homeDirectory: unknown): void {
  const values: KeptCredentials["values"] = {}
  for (const name of inheritedNames) {
    const value = process.env[name]
    if (value !== undefined && value !== "") values[name] = value
    delete process.env[name]
  }
  if (Object.keys(values).length === 0) return
  let home: string
  try {
    home = resolve(typeof homeDirectory === "string" ? homeDirectory : homedir())
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
  let path: string
  try {
    path = realpathSync.native(profileDirectory(profileLocation(homeDirectory, configuredProfileDirectory(environment.DOMOVOI_PROFILE_DIR, homeDirectory))))
  } catch {
    return undefined
  }
  const pending = kept.find((candidate) => candidate.identity.kind === "path" && candidate.identity.path === path)
  if (pending) pending.identity = identity
  return pending
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
  captureInheritedCredentials(homeDirectory)
  const filled: NodeJS.ProcessEnv = { ...environment, ...overrides }
  if (environment !== process.env) return filled
  const entry = keptFor(filled, homeDirectory)
  if (!entry) return filled
  for (const name of inheritedNames) {
    const value = entry.values[name]
    if (value !== undefined && overrides[name] === undefined) filled[name] = value
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
