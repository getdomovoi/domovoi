import { randomBytes } from "node:crypto"
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises"
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
//   directory being a link removes nothing. The profile is checked as the
//   runtime directory is built from it, so a trailing separator or a "." or
//   ".." cannot hide a link, and the spelling given must name the same
//   directory.
// - Paths are compared as profile directories are (sameProfileDirectory):
//   by file identity where both exist. A comparison that fails keeps the
//   candidate. Each kept copy is also resolved through every link, and a
//   candidate that holds one, or that one holds, is kept (round 1): a kept
//   copy's path can lead through a link into another candidate. A kept copy
//   that cannot be resolved, for any reason but not being there, removes
//   nothing. A kept copy whose profile, runtime, version or id directory, as
//   the definition spells it, is a link removes nothing either (round 2): a
//   link inside a candidate can lead on to a copy outside it.
// - Every component of the two paths the service runs for each kept copy,
//   its Node and its daemon entry, is walked as the definition spells it,
//   from the filesystem root to the file (round 3). Nothing is removed when
//   one is a link at or below the runtime directory, or a link that sits or
//   leads there; when one lies in the runtime directory apart from that
//   copy's own directory and those above it; when a read fails; or when the
//   copy is there but a file the service runs is not. Only a copy that is
//   not there at all ends its walk early. A link above the runtime directory that stays out
//   of it, a linked home directory for one, still cleans up.
// - A candidate is moved to a private name beside the copies, by one rename,
//   and removed only if what moved is still the directory that was checked.
//   Anything else is moved back. When anything after the rename fails, what
//   was moved goes back too (round 3); if it cannot, the cleanup throws
//   rather than say nothing was removed.
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
  // The path with every link in it resolved.
  realpath(path: string): Promise<string>
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
    realpath: (path) => realpath(path),
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
    // Security review round 1 of #635 (P2): lstat of "linked/" or "linked/."
    // looks through the link, and path.join folds "linked/x/.." into the
    // link. The profile is checked as the runtime directory is built from it,
    // its parent, and the spelling given must name that same directory.
    const profile = paths.dirname(root)
    if (!paths.isAbsolute(options.profileDirectory) || same(paths.dirname(paths.dirname(published)), root) !== true
      || same(options.profileDirectory, profile) !== true
      || await fs.entry(profile) !== "directory" || await fs.entry(root) !== "directory") {
      return { skipped: "runtime-directory" }
    }
    // Security review round 2 of #635 (P2): a kept copy's path can run through
    // a link inside a candidate on to a directory outside it. The copy is then
    // apart from the candidate, yet removing the candidate removes the link,
    // and the path the definition names no longer leads to Node. Protecting
    // only where the path ends cannot see that, so a kept copy named through
    // a link removes nothing.
    for (const copy of kept) {
      if (!await namedThroughDirectories(fs, paths, copy)) return { skipped: "runtime-directory" }
    }
    // Security review round 3 of #635 (P2): the profile's spelling can run
    // through a link inside a candidate, and so can Node, the daemon entry or
    // a directory between them and the copy. Every component of both paths
    // is checked, not only the copy's own directories.
    let runtime: string
    try {
      runtime = await fs.realpath(root)
    } catch {
      return { skipped: "runtime-directory" }
    }
    for (const copy of kept) {
      if (!await executablesStayClear(fs, paths, platform, runtime, copy)) return { skipped: "runtime-directory" }
    }
    let keptTrees: Tree[]
    try {
      keptTrees = await Promise.all(kept.map((copy) => tree(fs, paths, copy)))
    } catch {
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
      if (!await apart(fs, paths, candidate, keptTrees)) continue
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

// True when the kept copy's profile, runtime, version and id directories, as
// the definition spells them, are each a real directory, up to the first that
// is not there: a copy that is not there holds nothing. A link, anything else
// or a read that fails is false. What is above the profile, and what is below
// the copy, is left to executablesStayClear.
async function namedThroughDirectories(fs: RuntimeCleanupFileSystem, paths: typeof posix, copy: string): Promise<boolean> {
  const version = paths.dirname(copy)
  const runtime = paths.dirname(version)
  try {
    for (const path of [paths.dirname(runtime), runtime, version, copy]) {
      const found = await fs.entry(path)
      if (found === "missing") return true
      if (found !== "directory") return false
    }
    return true
  } catch {
    return false
  }
}

// Security review round 3 of #635 (P2): true only when no removal under the
// runtime directory can take away a component of the paths the service runs
// for this kept copy: <copy>/node/bin/node (node\node.exe on Windows) and
// <copy>/daemon/dist/index.js, as the definition spells them. Each path is
// walked from the filesystem root one component at a time. For each
// component the walk reads where the entry itself really is and, for a link,
// where it really leads. It is false when
// - a component at or below the copy's runtime directory, by its spelling, is
//   a link;
// - a link really sits, or really leads, at or inside the real runtime
//   directory (runtime);
// - anything really at or inside the runtime directory is neither the copy's
//   own real directory, a directory above it, nor inside it: that is where a
//   candidate is, whatever the spelling;
// - a component is missing below the copy's own directory, or a read fails.
// A copy that is not there at all holds nothing, so its walk ends at the
// first component that is not there. Candidates are compared without case,
// so a volume's case rules can only keep more.
async function executablesStayClear(fs: RuntimeCleanupFileSystem, paths: typeof posix, platform: string, runtime: string, copy: string): Promise<boolean> {
  const split = (path: string) => {
    const top = paths.parse(path).root
    return { top, parts: path.slice(top.length).split(paths.sep).filter((part) => part !== "") }
  }
  const fold = (path: string) => path.toLowerCase()
  const within = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(paths.sep) ? outer : outer + paths.sep)
  const inRuntime = (path: string) => within(fold(runtime), fold(path))
  // <profile>/runtime/<version>/<id>: the runtime directory is two above.
  const copyDepth = split(copy).parts.length
  const runtimeIndex = copyDepth - 3
  if (runtimeIndex < 0) return false
  const executables = [
    platform === "win32" ? paths.join(copy, "node", "node.exe") : paths.join(copy, "node", "bin", "node"),
    paths.join(copy, "daemon", "dist", "index.js"),
  ]
  try {
    for (const executable of executables) {
      const { top, parts } = split(executable)
      if (parts.some((part) => part === "." || part === "..")) return false
      let spelled = top
      let real = await fs.realpath(top)
      let copyReal: string | undefined
      const locations: string[] = []
      for (const [index, part] of parts.entries()) {
        spelled = paths.join(spelled, part)
        const found = await fs.entry(spelled)
        if (found === "missing") {
          // The copy is there, but not what the service runs: not known.
          if (index >= copyDepth) return false
          copyReal = paths.join(real, ...parts.slice(index, copyDepth))
          break
        }
        const own = paths.join(real, part)
        real = await fs.realpath(spelled)
        if (found === "link") {
          if (index >= runtimeIndex || inRuntime(own) || inRuntime(real)) return false
          locations.push(own)
        }
        locations.push(real)
        if (index === copyDepth - 1) copyReal = real
      }
      if (copyReal === undefined) return false
      const kept = copyReal
      if (!locations.every((location) => !inRuntime(location) || within(location, kept) || within(kept, location))) return false
    }
    return true
  } catch {
    return false
  }
}

// A directory resolved through every link: its real path, and the identity of
// it and of each directory above it. undefined when it is not there, since a
// copy that is not there cannot be inside anything.
type Tree = { real: string; identity: string; lineage: string[] } | undefined

async function tree(fs: RuntimeCleanupFileSystem, paths: typeof posix, path: string): Promise<Tree> {
  let real: string
  try {
    real = await fs.realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const known = async (at: string) => {
    const identity = await fs.identity(at)
    // A volume that reports no inode (ino 0) cannot be compared.
    if (identity.endsWith(":0")) throw new Error(`${at} reports no file identity`)
    return identity
  }
  const identity = await known(real)
  const lineage = [identity]
  for (let at = real; paths.dirname(at) !== at;) {
    at = paths.dirname(at)
    lineage.push(await known(at))
  }
  return { real, identity, lineage }
}

// Security review round 1 of #635 (P2): a kept copy's path can lead through a
// link into a candidate, an ordinary copy or an interrupted removal, that
// holds it. True only when the candidate and every kept copy are apart:
// neither is the other or inside it, by the identity of each directory
// above them and by their real paths compared without case, so a volume's
// case or spelling rules can only keep more. Anything that fails keeps it.
async function apart(fs: RuntimeCleanupFileSystem, paths: typeof posix, candidate: string, kept: Tree[]): Promise<boolean> {
  try {
    const own = await tree(fs, paths, candidate)
    if (own === undefined) return false
    const fold = (path: string) => path.toLowerCase()
    const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(paths.sep) ? outer : outer + paths.sep)
    return kept.every((copy) => copy === undefined || (
      !copy.lineage.includes(own.identity) && !own.lineage.includes(copy.identity)
      && !holds(fold(own.real), fold(copy.real)) && !holds(fold(copy.real), fold(own.real))
    ))
  } catch {
    return false
  }
}

// Moves the candidate to a private name under the runtime directory, then
// removes it only if what moved is the directory that was checked. Anything
// else, or anything after the rename that fails, puts back what moved.
async function removeCopy(fs: RuntimeCleanupFileSystem, paths: typeof posix, root: string, candidate: string): Promise<boolean> {
  let checked: string
  let moved: string
  try {
    checked = await fs.identity(candidate)
    if (await fs.entry(candidate) !== "directory") return false
    moved = paths.join(root, `.removing-${randomBytes(6).toString("hex")}`)
    if (await fs.entry(moved) !== "missing") return false
  } catch {
    return false
  }
  try {
    // A rename moves the entry itself and never goes through a link.
    await fs.rename(candidate, moved)
    if (await fs.entry(moved) === "directory" && await fs.identity(moved) === checked) {
      await fs.removeTree(moved)
      return true
    }
  } catch {
    // The rename can land and the flush after it fail, or the removal can
    // stop partway: either way, what moved goes back below.
  }
  await putBack(fs, candidate, moved)
  return false
}

// Security review round 3 of #635 (P2): a copy left under a private name is
// removed by the next cleanup as an interrupted removal, so a cleanup that
// stops after its rename must not report that nothing was removed. What
// moved goes back to the candidate's name. Settled only when nothing is left
// under the private name and the candidate's name holds something again;
// otherwise, or when a read fails, this throws.
async function putBack(fs: RuntimeCleanupFileSystem, candidate: string, moved: string): Promise<void> {
  if (await fs.entry(candidate) === "missing" && await fs.entry(moved) !== "missing") {
    try {
      await fs.rename(moved, candidate)
    } catch {
      // The flush after the rename can fail once it has landed; the reads
      // below decide.
    }
  }
  if (await fs.entry(moved) !== "missing" || await fs.entry(candidate) === "missing") {
    throw new Error(`${candidate} was moved to ${moved} for removal and could not be put back`)
  }
}

// The lease is the one installs and updates take (nodeServiceEffects).
export function nodeDaemonRuntimeCleanupDependencies(): DaemonRuntimeCleanupDependencies {
  return {
    ...nodeDaemonServiceRuntimeReader(),
    claimServiceOperation: nodeServiceEffects().claimServiceOperation,
  }
}
