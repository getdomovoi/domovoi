import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { posix, win32 } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { isLoginServiceRuntimeVersion } from "@getdomovoi/protocol"

import type { DaemonServiceRuntime } from "./desktop-service.js"

// The copy of the runtime the Domovoi app ships, made under the profile so the
// login service never runs from inside the app. The desktop's Install
// (apps/desktop/src/main/daemon-service.ts) and `domovoid service install` run
// from the app's runtime (install.ts, Q408 A) both make it here, so there is
// one copy routine. It moved from the desktop unchanged.

export class DaemonServiceRuntimeMissingError extends Error {
  constructor(
    readonly part: "node" | "daemon",
    readonly path: string,
    reason: "missing" | "not-file" | "relative",
    operation: "install" | "update" = "install",
  ) {
    const what = part === "node" ? "The Node runtime this app ships" : "The Domovoi daemon this app ships"
    const why = reason === "relative"
      ? `is named by a relative path, ${path}`
      : reason === "not-file" ? `is not a runnable file at ${path}` : `was not found at ${path}`
    const outcome = operation === "install"
      ? "No service was installed and no service files were changed."
      : "The service was not updated and no service files were changed."
    super(`${what} ${why}. ${outcome}`)
    this.name = "DaemonServiceRuntimeMissingError"
  }
}

// No staging place could be used (prepareDaemonRuntime). The message is the
// app's; `domovoid service install` words it for the command
// (bundled-runtime.ts) from the directory that failed under the data
// directory, when one did, and the directories made before the refusal,
// outermost first.
export class DaemonRuntimeStagingRefusedError extends Error {
  constructor(readonly profileDirectory: string, readonly failed: string | undefined = undefined, readonly made: readonly string[] = []) {
    super(`The profile directory ${profileDirectory} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`)
    this.name = "DaemonRuntimeStagingRefusedError"
  }
}

const runtimeDirectory = "daemon-runtime"

export function daemonRuntimeLayout(resourcesPath: string, platform: string): DaemonServiceRuntime {
  const path = platform === "win32" ? win32 : posix
  return {
    nodePath: platform === "win32"
      ? path.join(resourcesPath, runtimeDirectory, "node", "node.exe")
      : path.join(resourcesPath, runtimeDirectory, "node", "bin", "node"),
    daemonEntryPath: path.join(resourcesPath, runtimeDirectory, "daemon", "dist", "index.js"),
  }
}

// The app's version names the copy's directory, so it must be exactly one
// directory name: isLoginServiceRuntimeVersion, the same check the daemon
// reads a service's version back with (round 8). The refusal shows at most
// that many characters of it.
const maximumRuntimeVersionLength = 64

// Cause strings below are shown as the detail under "Could not install the
// service". They are new in security review round 1 of #576 and were
// approved by fetzy on 2026-09-25.
//
// Security review round 3 of #577 (P2): the copy goes under the selected
// profile (<profile>/runtime/<version>; ~/.domovoi for the default profile),
// because staging runs before the service calls bind the profile under their
// lease. A refused change then replaces at most its own profile's copy, never
// the one another profile's service runs.
export function profileRuntimeDirectory(profileDirectory: string, version: string, platform: string): string {
  const path = platform === "win32" ? win32 : posix
  if (!isLoginServiceRuntimeVersion(version)) {
    throw new Error(`The app version "${version.slice(0, maximumRuntimeVersionLength)}" is not a release version, so no runtime was copied.`)
  }
  const root = path.join(profileDirectory, "runtime")
  const destination = path.join(root, version)
  // Belt and braces for the pattern: the copy is one name directly under root.
  if (path.dirname(destination) !== root || path.basename(destination) !== version) {
    throw new Error(`The app version "${version}" is not a release version, so no runtime was copied.`)
  }
  return destination
}

export type RuntimeEntry = "file" | "directory" | "link" | "other" | "missing"

// What staging needs from the file system, so tests can fail one step. The
// node implementation never follows a link where it asks what a path is.
export type RuntimeFileSystem = {
  entry(path: string): Promise<RuntimeEntry>
  children(path: string): Promise<string[]>
  readLink(path: string): Promise<string>
  realpath(path: string): Promise<string>
  // One directory, not its parents; a directory already there is fine.
  makeDirectory(path: string): Promise<void>
  // Copies a tree, keeping each link as the link it is.
  copy(from: string, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  // Device and inode of the entry itself, never through a link.
  identity(path: string): Promise<string>
  // A new directory only this user can use, named by the prefix plus a random
  // suffix.
  makePrivateDirectory(prefix: string): Promise<string>
  // Whether the path is on a read-only mount, as a disk image is
  // (bundled-runtime.ts, unstableAppLocation).
  readOnly(path: string): Promise<boolean>
  // Owner and mode of the entry itself, never through a link (POSIX only).
  permissions(path: string): Promise<{ uid: number; mode: number }>
}

// A read-only mount, by what access(2) answers when asked for write access
// to the path: EROFS, which macOS and Linux return for a file on a read-only
// file system whatever its permissions. A disk image macOS mounts under
// /Volumes is read only (the compressed and read-only formats a download
// uses); an external drive there is not. It spawns no tool and needs no
// mount table. Any other answer, a missing path or a permission refusal
// included, is not read only. Limit: a disk image mounted writable answers
// like an external drive. The desktop's command links ask the same way
// (apps/desktop/src/main/command-links.ts).
export async function readOnlyMount(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EROFS"
  }
}

export function nodeRuntimeFileSystem(overrides: Partial<RuntimeFileSystem> = {}): RuntimeFileSystem {
  return {
    entry: async (path) => {
      try {
        const found = await lstat(path)
        return found.isSymbolicLink() ? "link" : found.isFile() ? "file" : found.isDirectory() ? "directory" : "other"
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
        throw error
      }
    },
    children: (path) => readdir(path),
    readLink: (path) => readlink(path),
    realpath: (path) => realpath(path),
    makeDirectory: async (path) => {
      try {
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    },
    copy: (from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
    // Each rename is followed by a flush of the directory that holds it.
    rename: (from, to) => publishFileDurably(from, to),
    identity: async (path) => {
      const found = await lstat(path, { bigint: true })
      return `${found.dev}:${found.ino}`
    },
    makePrivateDirectory: (prefix) => mkdtemp(prefix),
    readOnly: readOnlyMount,
    permissions: async (path) => {
      const found = await lstat(path)
      return { uid: found.uid, mode: found.mode }
    },
    ...overrides,
  }
}

function inside(pathApi: typeof posix, root: string, path: string): boolean {
  const relative = pathApi.relative(root, path)
  return relative === "" || (relative.split(pathApi.sep)[0] !== ".." && !pathApi.isAbsolute(relative))
}

// PR #712 security review round 2 (P2): the windows between a check and the
// mkdtemp, copy and rename it guards (Q411 A) are accepted only because no
// other account can reach them. So a staging place, given by its real path,
// must be one only this user (and root) can change, along with every
// directory above it: otherwise another account could rename or replace the
// private staging directory in it. Returns the first directory that fails,
// or undefined.
//
// POSIX: each directory, from the place up to /, owned by this user or
// root, and writable by neither group nor others, except a directory owned
// by root with the sticky bit set, as /tmp is, where only an entry's owner
// can rename or remove it. A group-writable directory fails even when only
// this user is in the group: membership cannot be read here. Windows: Node
// cannot read ACLs, so only a place inside this user's own profile
// directory passes; that holds the default TEMP (%LOCALAPPDATA%\Temp) and
// the app's userData (%APPDATA%). A failure to read fails the place.
export async function unprotectedStagingDirectory(real: string, options: {
  platform: string
  fileSystem: RuntimeFileSystem
  // Windows: this user's profile directory; os.homedir() by default.
  userDirectory?: string
  // POSIX: this user's id; process.getuid() by default.
  uid?: number
}): Promise<string | undefined> {
  const fs = options.fileSystem
  try {
    if (options.platform === "win32") {
      const user = (await fs.realpath(options.userDirectory ?? homedir())).toLowerCase()
      return inside(win32, user, real.toLowerCase()) ? undefined : real
    }
    const me = options.uid ?? process.getuid?.()
    if (me === undefined) return real
    for (let at = real; ; at = posix.dirname(at)) {
      const { uid, mode } = await fs.permissions(at)
      const othersWrite = (mode & 0o022) !== 0
      const rootSticky = uid === 0 && (mode & 0o1000) !== 0
      if ((uid !== me && uid !== 0) || (othersWrite && !rootSticky)) return at
      if (posix.dirname(at) === at) return undefined
    }
  } catch {
    return real
  }
}

// Each shipped part must be a regular file reached through real directories,
// and every link in the shipped tree must be relative and stay inside it, so
// the copy runs nothing from outside the app and still works after the app
// moves. All of it is checked before any byte is copied.
async function checkShippedRuntime(fs: RuntimeFileSystem, pathApi: typeof posix, shippedRoot: string, platform: string, operation: "install" | "update"): Promise<void> {
  const shipped = daemonRuntimeLayout(pathApi.dirname(shippedRoot), platform)
  for (const [part, path] of [["node", shipped.nodePath], ["daemon", shipped.daemonEntryPath]] as const) {
    const steps = pathApi.relative(shippedRoot, path).split(pathApi.sep)
    let at = shippedRoot
    for (const [index, step] of ["", ...steps].entries()) {
      at = step === "" ? at : pathApi.join(at, step)
      const found = await fs.entry(at)
      if (found === "missing") throw new DaemonServiceRuntimeMissingError(part, path, "missing", operation)
      if (found !== (index === steps.length ? "file" : "directory")) throw new DaemonServiceRuntimeMissingError(part, path, "not-file", operation)
    }
  }
  const realRoot = await fs.realpath(shippedRoot)
  const pending = [shippedRoot]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const name of await fs.children(directory)) {
      const path = pathApi.join(directory, name)
      const found = await fs.entry(path)
      if (found === "directory") pending.push(path)
      else if (found === "link") {
        const target = await fs.readLink(path)
        let resolved: string | undefined
        try { resolved = await fs.realpath(path) } catch { resolved = undefined }
        if (pathApi.isAbsolute(target) || !inside(pathApi, shippedRoot, pathApi.resolve(directory, target))
          || resolved === undefined || !inside(pathApi, realRoot, resolved)) {
          throw new Error(`The runtime this app ships holds a link that leads outside it, at ${path}. Nothing was copied.`)
        }
      } else if (found !== "file") {
        throw new Error(`The runtime this app ships holds something that is not a file or a directory, at ${path}. Nothing was copied.`)
      }
    }
  }
}

// The profile directory and its runtime directory must be real directories
// owned by this profile: a link there would send the copy, and the
// replacement of an earlier copy, somewhere else. Checking makes nothing and
// allows a missing one; publish makes the missing ones, private to the user
// (the profile's parent must exist), and checks again. Whether the runtime
// directory is there now is returned.
//
// Security review round 1 of #635 (P2): lstat of "linked/" or "linked/."
// looks through the link, and path.join folds "linked/x/.." into it. The
// profile is checked as the runtime directory is built from it, its parent;
// the real path check below then ties that to the spelling given.
async function runtimeRoot(fs: RuntimeFileSystem, pathApi: typeof posix, profileDirectory: string, make: boolean): Promise<boolean> {
  const root = pathApi.join(profileDirectory, "runtime")
  for (const at of [pathApi.dirname(root), root]) {
    if (make && await fs.entry(at) === "missing") await fs.makeDirectory(at)
    const found = await fs.entry(at)
    if (found === "missing" && !make) return false
    if (found !== "directory") {
      throw new Error(`${at} is not a directory (it may be a link), so no runtime was copied under it.`)
    }
  }
  if (await fs.realpath(root) !== pathApi.join(await fs.realpath(profileDirectory), "runtime")) {
    throw new Error(`${root} does not resolve inside the profile directory, so no runtime was copied under it.`)
  }
  return true
}

// The real path of a directory that may not exist yet: its nearest existing
// ancestor resolved, with the missing names after it. That ancestor's device
// is the one a directory made there will be on.
async function resolvedAhead(fs: RuntimeFileSystem, pathApi: typeof posix, path: string): Promise<{ realpath: string; identity: string }> {
  let at = path
  while (await fs.entry(at) === "missing" && pathApi.dirname(at) !== at) at = pathApi.dirname(at)
  return { realpath: pathApi.join(await fs.realpath(at), pathApi.relative(at, path)), identity: await fs.identity(at) }
}

// The copy under the profile outlives app updates and moves; the service
// points at it, never into the app bundle. The shipped runtime and the
// profile's runtime directory are checked before anything is written, so a
// half-shipped app or a redirected profile installs nothing.
//
// Security review round 7 of #577: each publish writes a fresh directory,
// <profile>/runtime/<version>/<id>, that nothing else ever uses. It never
// moves, replaces or deletes an earlier copy, so a failure after it leaves the
// runtime the previous service runs as it was: there is no shared state to put
// back, and a late or concurrent publish cannot replace another copy.
// Preparing only checks and chooses, and makes no directory, the profile's
// own included (round 8); the service calls run publish under their
// service-operation lease, after every profile check, so a refused change
// writes nothing.
//
// Rounds 5 to 7 (P2): the copy is made in a private directory outside every
// profile and moved in by one rename, so a swapped path cannot redirect the
// copy. Every staging place is checked the same way before anything is made
// there: a real directory on the runtime directory's volume, outside the
// selected profile, outside any other profile (round 8: a directory named
// .domovoi or holding profile-lease.sqlite) and outside any repository (a
// directory holding .git, as the repository finder reads it). The system
// temporary directory is tried first,
// then <app data>/runtime-staging; otherwise nothing is written. Copy approved
// by fetzy on 2026-09-26. `domovoid service install` passes
// ${XDG_STATE_HOME:-~/.local/state}/domovoi as its data directory, for a
// system temporary directory on a tmpfs.
//
// The runtime directory is pinned by its device, inode and real path when it
// is checked, and must still be that directory right before the rename.
// Limits: Node has no calls relative to an open directory, so a swap in the
// instant between that check and the rename is not caught. Every publish
// leaves its private staging directory outside every profile: empty after a
// publish, holding the partial copy after a failure (round 8). It is only disk
// space.
//
// #635 (ruled Q60 A): once an install or update has confirmed its new
// service, the desktop asks the daemon to remove the copies under the
// profile that neither the service definition nor the one before this change
// names (removeUnusedDaemonRuntimes). A copy a failed change published stays
// until the next confirmed one.
export type PreparedDaemonRuntime = {
  // Where the published copy will be, and the shipped runtime it copies.
  runtime: DaemonServiceRuntime
  staged: DaemonServiceRuntime
  publish: () => Promise<void>
}

export type DaemonRuntimeStageInput = {
  resourcesPath: string
  // The profile the selected service runs: DOMOVOI_PROFILE_DIR, or ~/.domovoi.
  profileDirectory: string
  version: string
  platform: string
  fileSystem: RuntimeFileSystem
  // The words for a missing part follow what was asked (approved 2026-09-23).
  operation?: "install" | "update"
  // The only staging place to try; tests pass their own.
  stagingParent?: string
  // The app's own data directory, the staging place when the system
  // temporary directory cannot be used. It may be missing; publish makes it
  // then, with any missing directories above it.
  dataDirectory?: string
}

export async function prepareDaemonRuntime(input: DaemonRuntimeStageInput): Promise<PreparedDaemonRuntime> {
  const fs = input.fileSystem
  const pathApi = input.platform === "win32" ? win32 : posix
  if (!pathApi.isAbsolute(input.profileDirectory)) {
    throw new Error(`The profile directory ${input.profileDirectory} is not an absolute path, so no runtime was copied.`)
  }
  const versionDirectory = profileRuntimeDirectory(input.profileDirectory, input.version, input.platform)
  const shippedRoot = pathApi.join(input.resourcesPath, runtimeDirectory)
  await checkShippedRuntime(fs, pathApi, shippedRoot, input.platform, input.operation ?? "install")
  // Round 8 (P2): preparing reads only. The profile directory, its runtime
  // directory and <app data>/runtime-staging may be missing now; publish
  // makes them under the service-operation lease and checks them again.
  const root = pathApi.join(input.profileDirectory, "runtime")
  const pin = async () => ({ identity: await fs.identity(root), realpath: await fs.realpath(root) })
  let pinned = await runtimeRoot(fs, pathApi, input.profileDirectory, false) ? await pin() : undefined
  // The version directory when it is already there, a real directory, so a
  // publish can tell it was not replaced since.
  const versionPrepared = pinned !== undefined && await fs.entry(versionDirectory) === "directory"
    ? { identity: await fs.identity(versionDirectory), realpath: await fs.realpath(versionDirectory) }
    : undefined
  const samePath = (left: string, right: string) => input.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
  const unchanged = async () => {
    const intact = pinned !== undefined
      && await fs.entry(pathApi.dirname(root)) === "directory"
      && await fs.entry(root) === "directory"
      && await fs.identity(root) === pinned.identity
      && samePath(await fs.realpath(root), pinned.realpath)
    if (!intact) throw new Error(`${root} changed while the runtime was copied, so it was not published.`)
  }
  const device = (identity: string) => identity.slice(0, identity.indexOf(":"))
  // Round 8 (P2): outside every profile, not only the selected one. A
  // profile any daemon has claimed holds profile-lease.sqlite, which is never
  // removed (file-lease.ts), and a default profile is named .domovoi; a
  // repository holds .git. Round 9 (P2): the name is compared case-folded on
  // every platform, since a case-insensitive volume (the macOS and Windows
  // default, and some Linux mounts) makes .DOMOVOI the same directory. The
  // marker files are looked up by lstat, so the volume's own case rules apply.
  const insideRepositoryOrProfile = async (path: string) => {
    for (let at = path; ; at = pathApi.dirname(at)) {
      if (pathApi.basename(at).toLowerCase() === ".domovoi") return true
      for (const marker of [".git", "profile-lease.sqlite"]) {
        if (await fs.entry(pathApi.join(at, marker)) !== "missing") return true
      }
      if (pathApi.dirname(at) === at) return false
    }
  }
  const ahead = await resolvedAhead(fs, pathApi, root)
  const runtimeDevice = device(pinned?.identity ?? ahead.identity)
  const profile = (await resolvedAhead(fs, pathApi, input.profileDirectory)).realpath
  // The directory that made the last usable() fail because another account
  // could change it (unprotectedStagingDirectory), so a refusal names it.
  let unprotected: string | undefined
  const usable = async (path: string) => {
    unprotected = undefined
    if (!pathApi.isAbsolute(path) || await fs.entry(path) !== "directory") return false
    if (device(await fs.identity(path)) !== runtimeDevice) return false
    const real = await fs.realpath(path)
    if (inside(pathApi, profile, real) || await insideRepositoryOrProfile(real)) return false
    unprotected = await unprotectedStagingDirectory(real, { platform: input.platform, fileSystem: fs })
    return unprotected === undefined
  }
  const refusal = (failed: string | undefined, made: readonly string[] = []) => new DaemonRuntimeStagingRefusedError(input.profileDirectory, failed, made)
  // The data directories this staging needs that are not there yet, outermost
  // first: made one at a time, each checked again with usable, at publish.
  // The app's data directory is always there; the one `domovoid service
  // install` passes (bundled-runtime.ts) may not be. A missing one is usable
  // when its nearest existing directory is and the whole path, resolved
  // through that directory, is outside every profile and repository, so a
  // refusal makes nothing.
  const missing: string[] = []
  // The existing directory the first missing one is made in, with its device
  // and inode when it was checked.
  let anchor: { path: string; identity: string } | undefined
  // The directory under the data directory that could not be used, if any.
  let failed: string | undefined
  const usableAhead = async (path: string) => {
    failed = path
    if (!pathApi.isAbsolute(path)) return false
    if (await fs.entry(path) !== "missing") {
      const identity = await fs.identity(path)
      if (!await usable(path)) {
        failed = unprotected ?? path
        return false
      }
      anchor = { path, identity }
      return true
    }
    // Each name above a missing path is made as written, so it must be
    // written plainly: no "..", ".", or doubled separator.
    if (pathApi.resolve(path) !== path) return false
    let at = path
    while (await fs.entry(at) === "missing" && pathApi.dirname(at) !== at) {
      missing.unshift(at)
      at = pathApi.dirname(at)
    }
    failed = at
    const identity = await fs.identity(at)
    if (!await usable(at)) {
      failed = unprotected ?? at
      return false
    }
    failed = path
    const real = pathApi.join(await fs.realpath(at), pathApi.relative(at, path))
    if (inside(pathApi, profile, real) || await insideRepositoryOrProfile(real)) return false
    anchor = { path: at, identity }
    return true
  }
  // PR #712 security review round 1 (P2): the staging place chosen, pinned
  // by device, inode and real path when it was checked: here when it is
  // there now, at publish when publish makes it.
  type Pin = { identity: string; realpath: string }
  const pinOf = async (path: string): Promise<Pin> => ({ identity: await fs.identity(path), realpath: await fs.realpath(path) })
  let stagingPin: Pin | undefined
  let parent: string | undefined
  if (input.stagingParent !== undefined) {
    if (await usable(input.stagingParent)) parent = input.stagingParent
    else failed = unprotected
  } else if (await usable(tmpdir())) {
    parent = tmpdir()
  } else if (input.dataDirectory !== undefined && await usableAhead(input.dataDirectory)) {
    const candidate = pathApi.join(input.dataDirectory, "runtime-staging")
    failed = candidate
    if (await fs.entry(candidate) === "missing") missing.push(candidate)
    if (missing.includes(candidate) || await usable(candidate)) parent = candidate
    else failed = unprotected ?? candidate
  }
  if (parent === undefined) throw refusal(failed)
  if (!missing.includes(parent)) stagingPin = await pinOf(parent)
  const stagingParent = parent
  const destination = pathApi.join(versionDirectory, randomUUID().replaceAll("-", "").slice(0, 12))
  const layout = (at: string): DaemonServiceRuntime => ({
    nodePath: input.platform === "win32" ? pathApi.join(at, "node", "node.exe") : pathApi.join(at, "node", "bin", "node"),
    daemonEntryPath: pathApi.join(at, "daemon", "dist", "index.js"),
  })
  let published = false
  const publish = async () => {
    if (published) throw new Error("This staged runtime was already published.")
    published = true
    // Review of the XDG state fallback (P3): mkdir follows a link in its
    // parent, so a level made here and then swapped for a link to a
    // repository or profile would have the next level made inside that
    // target. Right before each mkdir, the level above must still be a
    // directory with the device and inode it had when it was checked or
    // made. The instant between that check and the mkdir is not covered:
    // Node has no mkdir relative to an open directory. That is the residual
    // race security review round 8 of #577 accepted for the staging
    // directory; only a process of the same user can use it, and it can make
    // at most one empty directory, since the copy goes nowhere until the
    // whole chain is checked.
    const made: string[] = []
    let above = anchor
    for (const directory of missing) {
      if (await fs.entry(directory) === "missing") {
        if (above === undefined || await fs.entry(above.path) !== "directory" || await fs.identity(above.path) !== above.identity) {
          throw refusal(above?.path ?? directory, made)
        }
        await fs.makeDirectory(directory)
        made.push(directory)
      }
      const identity = await fs.identity(directory)
      if (!await usable(directory)) throw refusal(unprotected ?? directory, made)
      above = { path: directory, identity }
      if (directory === stagingParent) stagingPin = { identity, realpath: await fs.realpath(directory) }
    }
    await runtimeRoot(fs, pathApi, input.profileDirectory, true)
    pinned ??= await pin()
    await unchanged()
    if (await fs.entry(versionDirectory) === "missing") await fs.makeDirectory(versionDirectory)
    for (const path of [versionDirectory, destination]) {
      const found = await fs.entry(path)
      if (path === versionDirectory ? found !== "directory" : found !== "missing") {
        throw new Error(`${path} is not a directory (it may be a link), so no runtime was copied there.`)
      }
    }
    // PR #712 security review round 1 (P2): the rename's destination parent
    // is <profile>/runtime/<version>, not the runtime directory pinned
    // above, so it is pinned too: a real directory whose real path is the
    // pinned runtime directory's plus the version, and, when it was there
    // when preparing, the same directory as then.
    const versionPin = { identity: await fs.identity(versionDirectory), realpath: await fs.realpath(versionDirectory) }
    if (!samePath(versionPin.realpath, pathApi.join(pinned.realpath, input.version))
      || (versionPrepared !== undefined && (versionPrepared.identity !== versionPin.identity || !samePath(versionPrepared.realpath, versionPin.realpath)))) {
      throw new Error(`${versionDirectory} does not resolve inside the profile directory, so no runtime was copied there.`)
    }
    const versionUnchanged = async () => {
      const intact = await fs.entry(versionDirectory) === "directory"
        && await fs.identity(versionDirectory) === versionPin.identity
        && samePath(await fs.realpath(versionDirectory), versionPin.realpath)
      if (!intact) throw new Error(`${versionDirectory} changed while the runtime was copied, so it was not published.`)
      if (await fs.entry(destination) !== "missing") throw new Error(`${destination} appeared while the runtime was copied, so it was not published.`)
    }
    // PR #712 security review round 1 (P2): right before the private staging
    // directory is made, the staging place must still be the directory
    // pinned when it was checked or made, and still pass every check it
    // passed then (a real directory on the runtime's volume, outside every
    // profile and repository). The private directory made there must be a
    // real directory right under that place's real path; it is pinned, and
    // checked again, with the copy in it, before the copy is moved out.
    // Whatever was made is left where it is, as round 8 of #577 decided.
    const placeIntact = stagingPin !== undefined
      && await fs.entry(stagingParent) === "directory"
      && await fs.identity(stagingParent) === stagingPin.identity
      && samePath(await fs.realpath(stagingParent), stagingPin.realpath)
      && await usable(stagingParent)
    if (!placeIntact || stagingPin === undefined) throw new Error(`${stagingParent} changed after it was checked, so the runtime was not copied there.`)
    const holder = await fs.makePrivateDirectory(pathApi.join(stagingParent, `.domovoi-runtime-${input.version}.staging-`))
    const holderReal = pathApi.join(stagingPin.realpath, pathApi.basename(holder))
    // Round 2 (P2): the private staging directory is this user's and open to
    // no one else (mkdtemp makes it 0700). Windows has no POSIX mode; there
    // the place it is in was checked to be inside this user's profile.
    const holderPrivate = async () => {
      if (input.platform === "win32") return true
      const { uid, mode } = await fs.permissions(holder)
      return uid === process.getuid?.() && (mode & 0o077) === 0
    }
    if (await fs.entry(holder) !== "directory" || !samePath(await fs.realpath(holder), holderReal) || !await holderPrivate()) {
      throw new Error(`${holder} changed after it was made, so the runtime was not copied there.`)
    }
    const holderIdentity = await fs.identity(holder)
    const staging = pathApi.join(holder, "copy")
    await fs.copy(shippedRoot, staging)
    await unchanged()
    const copied = await fs.entry(holder) === "directory"
      && await fs.identity(holder) === holderIdentity
      && samePath(await fs.realpath(holder), holderReal)
      && await holderPrivate()
      && await fs.entry(staging) === "directory"
      && samePath(await fs.realpath(staging), pathApi.join(holderReal, "copy"))
    if (!copied) throw new Error(`${holder} changed while the runtime was copied, so it was not published.`)
    // Right before the rename. The instants between these checks and the
    // calls that follow them are not covered: Node has no mkdtemp, copy or
    // rename relative to an open directory, so each resolves its path again.
    // Round 2 (P2): only a process of this user can reach them. The staging
    // place and every directory above it are ones no other account can
    // change (unprotectedStagingDirectory, checked when chosen or made and
    // again right before mkdtemp), and the private staging directory is this
    // user's, mode 0700; the profile is this user's own. Such a process
    // that swaps a checked directory for a link in
    // such an instant can have: the private staging directory made in the
    // link's target (one empty directory); the copy of the shipped runtime,
    // which holds no secrets, written there; or that copy, or a directory of
    // its own in place of it, moved into <profile>/runtime/<version> or, by
    // swapping that, this copy moved into another directory on the same
    // volume under its fresh name. Nothing is replaced or removed, and that
    // user can already write the profile and the runtime under it. Ruled
    // Q411 A (2026-10-03): these windows are narrowed and documented, not
    // closed with a native helper, as round 8 of #577 accepted the same race
    // for the staging directory.
    await versionUnchanged()
    await fs.rename(staging, destination)
    // Round 8 (P2): the staging directory, empty now, is left where it is.
    // Node cannot remove a directory relative to one it holds open, so a
    // check that the path is still this directory cannot be bound to its
    // removal: a directory swapped in between would be removed instead.
  }
  return { runtime: layout(destination), staged: layout(shippedRoot), publish }
}

// Prepare and publish at once, for callers with no lease to publish under.
export async function stageDaemonRuntime(input: DaemonRuntimeStageInput): Promise<DaemonServiceRuntime> {
  const prepared = await prepareDaemonRuntime(input)
  await prepared.publish()
  return prepared.runtime
}
