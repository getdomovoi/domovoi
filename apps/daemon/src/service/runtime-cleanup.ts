import { randomBytes } from "node:crypto"
import { lstat, readdir, rm, rmdir } from "node:fs/promises"
import { posix, win32 } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { isLoginServiceRuntimeVersion } from "@getdomovoi/protocol"

import type { FileLease } from "../file-lease.js"
import { sameProfileDirectory } from "../profile-directory.js"
import {
  nodeDaemonServiceRuntimeReader,
  readDaemonServiceRuntimeCopy,
  type DaemonServiceRuntime,
  type DaemonServiceRuntimeCopy,
  type DaemonServiceRuntimeReader,
} from "./desktop-service.js"
import { nodeServiceEffects } from "./install.js"

// #635, ruled Q60 A (2026-09-26): each desktop install or update publishes the
// runtime into a fresh <profile>/runtime/<version>/<id> (#577, round 7), about
// 150 MB, and a failure after the publish leaves one too. Once a change has
// confirmed its new service, the desktop removes the copies no service
// definition names.
//
// Rules, all failing closed: a candidate is kept whenever anything about it
// is uncertain.
// - Runs only under the service-operation lease. Every publish runs under it
//   too, and an update holds it until a publish its deadline gave up on has
//   settled, so no copy is being written or registered meanwhile. A busy lease
//   removes nothing.
// - The definition must name exactly the copy this change published, read
//   again under the lease. Another change that took the service since then
//   cleans up after itself, keeping this copy as its previous one.
// - The copy the definition names now and the one it named before this
//   change are never removed. A previous definition that named anything else,
//   or could not be read, removes nothing: what it runs is not known.
// - Only <profile>/runtime/<version>/<id> directories are candidates, with
//   the version and id a publish uses, reached through real directories. A
//   link is never followed and never removed; the profile or its runtime
//   directory being a link removes nothing.
// - Paths are compared as profile directories are (sameProfileDirectory):
//   by file identity where both exist. A comparison that fails keeps the
//   candidate. It looks through links only on the side of the kept copies, so
//   it can keep more, never remove more.
// - A candidate is moved to a private name beside the copies, by one rename,
//   and removed only if what moved is still the directory that was checked.
//   Anything else is moved back.
//
// Limits: Node has no calls relative to an open directory, so the removal of
// the moved tree walks it by path; a process running as the same user can
// swap a directory inside it during that walk (same-user races, P3 by Q63).
// The service definition is read by name; WSL guest services have no
// definition this host can read, so their copies are never removed here.
export type RuntimeCleanupFileSystem = {
  // What the path is, never through a link.
  entry(path: string): Promise<"directory" | "link" | "other" | "missing">
  // Device and inode of the entry itself, never through a link.
  identity(path: string): Promise<string>
  children(path: string): Promise<string[]>
  rename(from: string, to: string): Promise<void>
  // A whole tree; links inside are removed, not followed.
  removeTree(path: string): Promise<void>
  // One directory, only when it is empty.
  removeEmptyDirectory(path: string): Promise<void>
}

export function nodeRuntimeCleanupFileSystem(overrides: Partial<RuntimeCleanupFileSystem> = {}): RuntimeCleanupFileSystem {
  return {
    entry: async (path) => {
      try {
        const found = await lstat(path)
        return found.isSymbolicLink() ? "link" : found.isDirectory() ? "directory" : "other"
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
        throw error
      }
    },
    identity: async (path) => {
      const found = await lstat(path, { bigint: true })
      return `${found.dev}:${found.ino}`
    },
    children: (path) => readdir(path),
    // Followed by a flush of the directory that holds it, so a name that
    // survives a power loss is either the copy's or the private one.
    rename: (from, to) => publishFileDurably(from, to),
    removeTree: (path) => rm(path, { recursive: true, force: false, maxRetries: 3 }),
    removeEmptyDirectory: (path) => rmdir(path),
    ...overrides,
  }
}

export type DaemonRuntimeCleanupDependencies = DaemonServiceRuntimeReader & {
  claimServiceOperation: () => FileLease
  fileSystem?: Partial<RuntimeCleanupFileSystem>
}

export type DaemonRuntimeCleanupOptions = {
  // The profile the copy was published under: DOMOVOI_PROFILE_DIR, or
  // ~/.domovoi.
  profileDirectory: string
  // The runtime this change published and its new service runs.
  published: DaemonServiceRuntime
  // What the service definition named before this change, read under the
  // change's own service-operation lease (readDaemonServiceRuntimeCopy).
  previous: DaemonServiceRuntimeCopy
}

export type DaemonRuntimeCleanupResult =
  | { removed: string[] }
  | { skipped: "previous-unknown" | "busy" | "definition-unknown" | "service-changed" | "runtime-directory" }

// The version and id a publish names a copy with (desktop-service.ts), and the
// private name a candidate is moved to before it is removed. No version
// starts with a dot, so the two never meet.
const publishId = /^[0-9a-f]{12}$/u
const removing = /^\.removing-[0-9a-f]{12}$/u

export async function removeUnusedDaemonRuntimes(
  options: DaemonRuntimeCleanupOptions,
  dependencies: DaemonRuntimeCleanupDependencies = nodeDaemonRuntimeCleanupDependencies(),
): Promise<DaemonRuntimeCleanupResult> {
  const { platform } = dependencies
  const paths = platform === "win32" ? win32 : posix
  if (options.previous.installed && options.previous.copy === undefined) return { skipped: "previous-unknown" }
  const kept = [...(options.previous.installed && options.previous.copy !== undefined ? [options.previous.copy] : [])]
  let lease: FileLease
  try {
    lease = dependencies.claimServiceOperation()
  } catch {
    return { skipped: "busy" }
  }
  try {
    let current: DaemonServiceRuntimeCopy
    try {
      current = await readDaemonServiceRuntimeCopy(dependencies)
    } catch {
      return { skipped: "definition-unknown" }
    }
    // true only when certain; a comparison that throws is not.
    const same = (left: string, right: string) => {
      try {
        return sameProfileDirectory({ profileDirectory: left }, { profileDirectory: right }, platform)
      } catch {
        return undefined
      }
    }
    // <copy>/daemon/dist/index.js
    const published = paths.dirname(paths.dirname(paths.dirname(options.published.daemonEntryPath)))
    if (!current.installed || current.copy === undefined || same(current.copy, published) !== true) return { skipped: "service-changed" }
    kept.push(current.copy)
    const fs = nodeRuntimeCleanupFileSystem(dependencies.fileSystem)
    const root = paths.join(options.profileDirectory, "runtime")
    if (!paths.isAbsolute(options.profileDirectory) || same(paths.dirname(paths.dirname(published)), root) !== true
      || await fs.entry(options.profileDirectory) !== "directory" || await fs.entry(root) !== "directory") {
      return { skipped: "runtime-directory" }
    }

    const candidates: string[] = []
    const versions: string[] = []
    for (const name of await fs.children(root)) {
      const path = paths.join(root, name)
      if (removing.test(name)) {
        if (await fs.entry(path) === "directory") candidates.push(path)
        continue
      }
      if (!isLoginServiceRuntimeVersion(name) || await fs.entry(path) !== "directory") continue
      versions.push(path)
      for (const id of await fs.children(path)) {
        const copy = paths.join(path, id)
        if (publishId.test(id) && await fs.entry(copy) === "directory") candidates.push(copy)
      }
    }
    const removed: string[] = []
    for (const candidate of candidates) {
      if (kept.some((copy) => same(candidate, copy) !== false)) continue
      if (await removeCopy(fs, paths, root, candidate)) removed.push(candidate)
    }
    // A version directory left empty goes too. One that is not empty, or no
    // longer a directory, stays.
    for (const version of versions) {
      try { await fs.removeEmptyDirectory(version) } catch { /* kept */ }
    }
    return { removed }
  } finally {
    lease.release()
  }
}

// Moves the candidate to a private name under the runtime directory, then
// removes it only if what moved is the directory that was checked.
async function removeCopy(fs: RuntimeCleanupFileSystem, paths: typeof posix, root: string, candidate: string): Promise<boolean> {
  try {
    const checked = await fs.identity(candidate)
    if (await fs.entry(candidate) !== "directory") return false
    const moved = paths.join(root, `.removing-${randomBytes(6).toString("hex")}`)
    if (await fs.entry(moved) !== "missing") return false
    // A rename moves the entry itself and never goes through a link.
    await fs.rename(candidate, moved)
    if (await fs.entry(moved) !== "directory" || await fs.identity(moved) !== checked) {
      if (await fs.entry(candidate) === "missing") await fs.rename(moved, candidate)
      return false
    }
    await fs.removeTree(moved)
    return true
  } catch {
    return false
  }
}

// The lease is the one installs and updates take (nodeServiceEffects).
export function nodeDaemonRuntimeCleanupDependencies(): DaemonRuntimeCleanupDependencies {
  return {
    ...nodeDaemonServiceRuntimeReader(),
    claimServiceOperation: nodeServiceEffects().claimServiceOperation,
  }
}
