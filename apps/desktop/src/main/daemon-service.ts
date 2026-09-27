import type { DaemonServiceInstallResult, DaemonServiceOptions, DaemonServiceRemovalResult, DaemonServiceRuntime, DaemonServiceStagedRuntime, DaemonServiceStatus } from "@getdomovoi/daemon"
import { publishFileDurably } from "@getdomovoi/credential-store"
import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { posix, win32 } from "node:path"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

// The daemon's own runtime-missing refusal, made here for the shipped parts
// this module checks itself. The daemon is loaded at run time (daemon-module),
// so its class is not importable here; both are recognised by name and shape.
export class DaemonServiceRuntimeMissingError extends Error {
  constructor(
    readonly part: "node" | "daemon",
    readonly path: string,
    reason: "missing" | "not-file",
    operation: "install" | "update" = "install",
  ) {
    const what = part === "node" ? "The Node runtime this app ships" : "The Domovoi daemon this app ships"
    const why = reason === "not-file" ? `is not a runnable file at ${path}` : `was not found at ${path}`
    const outcome = operation === "install"
      ? "No service was installed and no service files were changed."
      : "The service was not updated and no service files were changed."
    super(`${what} ${why}. ${outcome}`)
    this.name = "DaemonServiceRuntimeMissingError"
  }
}

// Security review round 2 of #577: the service calls check the profiles again
// under the service-operation lease and refuse before changing anything. An
// update carries that refusal as the cause of its nothing-changed error. Round 3: a
// registered service whose profile is not known is refused the same way.
function profileRefusal(cause: unknown): string | undefined {
  for (let at = cause, depth = 0; at instanceof Error && depth < 2; at = at.cause, depth += 1) {
    if (at.name === "ServiceProfileMismatchError" || at.name === "ServiceProfileUnknownError") return at.message
  }
  return undefined
}

function runtimeMissing(cause: unknown): { part: "node" | "daemon"; path: string; message: string } | undefined {
  if (!(cause instanceof Error) || cause.name !== "DaemonServiceRuntimeMissingError") return undefined
  const { part, path } = cause as Error & { part?: unknown; path?: unknown }
  if ((part !== "node" && part !== "daemon") || typeof path !== "string") return undefined
  return { part, path, message: cause.message }
}

// J24 (2026-09-23): keep Domovoi running after the app quits. The app ships
// Node and the daemon under its resources, copies them under the profile so
// the service outlives app updates and moves, and asks the daemon's own
// installer to register a per-user service pointing at that copy. The
// installer stops the in-app daemon only after its checks pass, through
// releaseInAppDaemon, so a bad runtime never interrupts anything. The switch
// refuses while a turn runs or a gate waits: the renderer checks the snapshot
// it holds, and this main-process side checks the daemon's own workspace with
// the same function before anything is stopped.

export type DaemonServiceOutcome =
  | { ok: true; kind: "file" | "task"; target: string; configurationPath: string; daemonRunning: true }
  // daemonRunning: a daemon runs and this app reaches it. daemonAttached: that
  // daemon is one this app did not start, so quitting the app leaves it be.
  | { ok: true; kind: "file" | "task"; target: string; profileRecovery: DaemonServiceRemovalResult["profileRecovery"]; profileRecoveryDetail?: string; daemonRunning: boolean; daemonAttached: boolean }
  | { ok: false; reason: "runtime-missing"; part: "node" | "daemon"; path: string; message: string }
  // The service is installed and this app's daemon is stopped, but the app
  // could not attach to the service. It does not start its own daemon again:
  // the service may hold the profile.
  | { ok: false; reason: "installed-not-attached"; kind: "file" | "task"; target: string; message: string }
  | { ok: false; reason: "busy" | "refused" | "check-failed"; message: string }
  // What became of the daemon this app reaches: never stopped, started again
  // inside the app, attached to one the app did not start, or none. And the
  // service as read back after the failure, since a manager can fail after it
  // wrote or removed part of it; null when it could not be read.
  | { ok: false; reason: "failed"; message: string; daemon: "untouched" | "restarted" | "attached" | "stopped"; service: ServiceReadBack | null }
  // An in-place update that did not end with the new service running. The
  // message is the daemon's own, approved 2026-09-23 (update-outcome.ts).
  | { ok: false; reason: "update-failed"; message: string }

export type ServiceReadBack = { installed: boolean | null; running: boolean }

export type DaemonServiceStatusReport = DaemonServiceStatus | { unavailable: string }

export type ServiceHandoffFence = { refusal: string } | { release: () => void }

export type DesktopDaemonServiceDependencies = {
  // Copies the shipped runtime under the profile and names the copy, or
  // throws DaemonServiceRuntimeMissingError naming the part that is not there.
  stageRuntime: (operation: "install" | "update") => Promise<PreparedDaemonRuntime>
  install: (options: DaemonServiceOptions) => Promise<DaemonServiceInstallResult>
  status: () => Promise<DaemonServiceStatus>
  remove: () => Promise<DaemonServiceRemovalResult>
  // Moves the installed service to the staged runtime in place (ruled
  // 2026-09-23, B). Throws the daemon's DaemonServiceUpdateError on failure.
  update: (options: { runtime: DaemonServiceRuntime; staged: DaemonServiceStagedRuntime }) => Promise<DaemonServiceInstallResult>
  // Security review of #577 (P1): the profile this app's daemon runs against
  // the one the login service runs, both directories when they differ. The
  // turn check and the fence below reach only this app's daemon, so they bind
  // the service only when both are one profile. Throws when unreadable.
  profile: () => Promise<{ app: string; service: string } | undefined>
  // The turns running and gates waiting in the daemon's own workspace, named
  // as the renderer names them, or undefined when there are none. Throws when
  // the workspace cannot be read.
  refusal: () => Promise<string | undefined>
  // The daemon's own fence, taken right before the stop: the same refusal,
  // or no new turn there until release() or the daemon stops. The read above
  // is only a snapshot; a turn can start after it. Throws when the daemon
  // cannot be asked.
  fence: () => Promise<ServiceHandoffFence>
  daemon: {
    // Held while the service takes the profile or gives it back, so a
    // renderer reconnect waits instead of starting a daemon.
    beginHandoff(): void
    endHandoff(): void
    stopOwned(): Promise<void>
    attachOnly(): Promise<DesktopDaemonAcquisition>
    restart(): Promise<DesktopDaemonAcquisition>
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
// directory name: a release version (semver, as package.json holds it), with
// no separator, no "." or ".." and nothing a platform reserves.
const runtimeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
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
  if (version.length > maximumRuntimeVersionLength || !runtimeVersionPattern.test(version)) {
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
    ...overrides,
  }
}

function inside(pathApi: typeof posix, root: string, path: string): boolean {
  const relative = pathApi.relative(root, path)
  return relative === "" || (relative.split(pathApi.sep)[0] !== ".." && !pathApi.isAbsolute(relative))
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
async function runtimeRoot(fs: RuntimeFileSystem, pathApi: typeof posix, profileDirectory: string, make: boolean): Promise<boolean> {
  let at = profileDirectory
  for (const step of ["", "runtime"]) {
    at = step === "" ? at : pathApi.join(at, step)
    if (make && await fs.entry(at) === "missing") await fs.makeDirectory(at)
    const found = await fs.entry(at)
    if (found === "missing" && !make) return false
    if (found !== "directory") {
      throw new Error(`${at} is not a directory (it may be a link), so no runtime was copied under it.`)
    }
  }
  if (await fs.realpath(at) !== pathApi.join(await fs.realpath(profileDirectory), "runtime")) {
    throw new Error(`${at} does not resolve inside the profile directory, so no runtime was copied under it.`)
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
// by fetzy on 2026-09-26.
//
// The runtime directory is pinned by its device, inode and real path when it
// is checked, and must still be that directory right before the rename.
// Limits: Node has no calls relative to an open directory, so a swap in the
// instant between that check and the rename is not caught. Each successful
// install or update leaves the copies earlier services used; removing them is
// not built. Every publish leaves its private staging directory outside every
// profile: empty after a publish, holding the partial copy after a failure
// (round 8). It is only disk space.
export type PreparedDaemonRuntime = {
  // Where the published copy will be, and the shipped runtime it copies.
  runtime: DaemonServiceRuntime
  staged: DaemonServiceRuntime
  publish: () => Promise<void>
}

type StageInput = {
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
  // temporary directory cannot be used.
  dataDirectory?: string
}

export async function prepareDaemonRuntime(input: StageInput): Promise<PreparedDaemonRuntime> {
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
  const samePath = (left: string, right: string) => input.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
  const unchanged = async () => {
    const intact = pinned !== undefined
      && await fs.entry(input.profileDirectory) === "directory"
      && await fs.entry(root) === "directory"
      && await fs.identity(root) === pinned.identity
      && samePath(await fs.realpath(root), pinned.realpath)
    if (!intact) throw new Error(`${root} changed while the runtime was copied, so it was not published.`)
  }
  const device = (identity: string) => identity.slice(0, identity.indexOf(":"))
  // Round 8 (P2): outside every profile, not only the selected one. A
  // profile any daemon has claimed holds profile-lease.sqlite, which is never
  // removed (file-lease.ts), and a default profile is named .domovoi; a
  // repository holds .git.
  const insideRepositoryOrProfile = async (path: string) => {
    for (let at = path; ; at = pathApi.dirname(at)) {
      if (samePath(pathApi.basename(at), ".domovoi")) return true
      for (const marker of [".git", "profile-lease.sqlite"]) {
        if (await fs.entry(pathApi.join(at, marker)) !== "missing") return true
      }
      if (pathApi.dirname(at) === at) return false
    }
  }
  const ahead = await resolvedAhead(fs, pathApi, root)
  const runtimeDevice = device(pinned?.identity ?? ahead.identity)
  const profile = (await resolvedAhead(fs, pathApi, input.profileDirectory)).realpath
  const usable = async (path: string) => {
    if (!pathApi.isAbsolute(path) || await fs.entry(path) !== "directory") return false
    if (device(await fs.identity(path)) !== runtimeDevice) return false
    const real = await fs.realpath(path)
    return !inside(pathApi, profile, real) && !await insideRepositoryOrProfile(real)
  }
  const refusal = () => new Error(`The profile directory ${input.profileDirectory} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`)
  let parent: string | undefined
  // A staging place under the app's data directory that is not there yet:
  // made, and checked again, at publish.
  let makeParent = false
  if (input.stagingParent !== undefined) {
    if (await usable(input.stagingParent)) parent = input.stagingParent
  } else if (await usable(tmpdir())) {
    parent = tmpdir()
  } else if (input.dataDirectory !== undefined && await usable(input.dataDirectory)) {
    const candidate = pathApi.join(input.dataDirectory, "runtime-staging")
    makeParent = await fs.entry(candidate) === "missing"
    if (makeParent || await usable(candidate)) parent = candidate
  }
  if (parent === undefined) throw refusal()
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
    if (makeParent) {
      await fs.makeDirectory(stagingParent)
      if (!await usable(stagingParent)) throw refusal()
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
    const holder = await fs.makePrivateDirectory(pathApi.join(stagingParent, `.domovoi-runtime-${input.version}.staging-`))
    const staging = pathApi.join(holder, "copy")
    await fs.copy(shippedRoot, staging)
    await unchanged()
    await fs.rename(staging, destination)
    // Round 8 (P2): the staging directory, empty now, is left where it is.
    // Node cannot remove a directory relative to one it holds open, so a
    // check that the path is still this directory cannot be bound to its
    // removal: a directory swapped in between would be removed instead.
  }
  return { runtime: layout(destination), staged: layout(shippedRoot), publish }
}

// Prepare and publish at once, for callers with no lease to publish under.
export async function stageDaemonRuntime(input: StageInput): Promise<DaemonServiceRuntime> {
  const prepared = await prepareDaemonRuntime(input)
  await prepared.publish()
  return prepared.runtime
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// The fence answered a refusal, or could not be taken, inside the installer's
// handoff hook. Throwing it stops the install before anything is claimed.
class HandoffNotFenced extends Error {
  constructor(readonly outcome: DaemonServiceOutcome) {
    super(outcome.ok ? "" : outcome.message)
  }
}

export class DesktopDaemonService {
  #busy = false

  constructor(private readonly deps: DesktopDaemonServiceDependencies) {}

  async status(): Promise<DaemonServiceStatusReport> {
    try {
      return await this.deps.status()
    } catch (cause) {
      return { unavailable: message(cause) }
    }
  }

  async install(): Promise<DaemonServiceOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", message: "A service change is already in progress." }
    this.#busy = true
    let released = false
    let fence: { release: () => void } | undefined
    let prepared: PreparedDaemonRuntime | undefined
    try {
      const refused = (await this.#profileRefusal()) ?? (await this.#refusal())
      if (refused) return refused
      let installed: DaemonServiceInstallResult
      try {
        prepared = await this.deps.stageRuntime("install")
        installed = await this.deps.install({
          runtime: prepared.runtime,
          staged: { runtime: prepared.staged, publish: prepared.publish },
          releaseInAppDaemon: async () => {
            const held = await this.#fence()
            if (!("release" in held)) throw new HandoffNotFenced(held)
            fence = held
            released = true
            this.deps.daemon.beginHandoff()
            await this.deps.daemon.stopOwned()
          },
        })
      } catch (cause) {
        if (cause instanceof HandoffNotFenced) return cause.outcome
        const otherProfile = released ? undefined : profileRefusal(cause)
        if (otherProfile) return { ok: false, reason: "refused", message: otherProfile }
        // Recognised by name: the daemon's own class is loaded at run time.
        const missing = runtimeMissing(cause)
        if (missing) return { ok: false, reason: "runtime-missing", ...missing }
        // The stop happened and the install did not finish: the profile may
        // be free, so the app takes a daemon back rather than sit idle. The
        // manager may have written part of the service, so it is read back.
        const daemon = released ? await this.#daemonAfter() : "untouched"
        return { ok: false, reason: "failed", message: message(cause), daemon, service: await this.#serviceAfter() }
      }
      const target = installed.kind === "file" ? installed.path : installed.name
      let attached: DesktopDaemonAcquisition
      try {
        attached = await this.deps.daemon.attachOnly()
      } catch (cause) {
        return { ok: false, reason: "installed-not-attached", kind: installed.kind, target, message: message(cause) }
      }
      if (attached.kind === "refused") {
        return { ok: false, reason: "installed-not-attached", kind: installed.kind, target, message: attached.message }
      }
      // Security review round 9: reaching a daemon is not proof the service
      // took over. Another app's daemon, or one started by hand while the
      // service is stopped, answers the attach too. Success needs a daemon
      // outside any app and the service read back installed and running.
      if (attached.kind !== "attached" || attached.owner !== "daemon" || !(await this.#serviceRuns())) {
        // Approved by fetzy on 2026-09-25: the detail under "Installed, but
        // this window could not reach the daemon".
        return { ok: false, reason: "installed-not-attached", kind: installed.kind, target, message: "The daemon this window reached is not the running service." }
      }
      return { ok: true, kind: installed.kind, target, configurationPath: installed.configurationPath, daemonRunning: true }
    } finally {
      fence?.release()
      if (released) this.deps.daemon.endHandoff()
      this.#busy = false
    }
  }

  async remove(): Promise<DaemonServiceOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", message: "A service change is already in progress." }
    this.#busy = true
    let held = false
    let fence: { release: () => void } | undefined
    try {
      const refused = (await this.#profileRefusal()) ?? (await this.#refusal())
      if (refused) return refused
      const fenced = await this.#fence()
      if (!("release" in fenced)) return fenced
      fence = fenced
      held = true
      this.deps.daemon.beginHandoff()
      let removed: DaemonServiceRemovalResult
      try {
        removed = await this.deps.remove()
      } catch (cause) {
        const otherProfile = profileRefusal(cause)
        if (otherProfile) return { ok: false, reason: "refused", message: otherProfile }
        // The manager can fail after it unloaded or deleted part of the
        // service. Read it back; unless it still runs, take a daemon back.
        const service = await this.#serviceAfter()
        const daemon = service?.installed === true && service.running ? "untouched" : await this.#daemonAfter()
        return { ok: false, reason: "failed", message: message(cause), daemon, service }
      }
      const daemon = await this.#daemonAfter()
      const reached = { daemonRunning: daemon !== "stopped", daemonAttached: daemon === "attached" }
      const recovery = { profileRecovery: removed.profileRecovery, ...(removed.profileRecoveryDetail === undefined ? {} : { profileRecoveryDetail: removed.profileRecoveryDetail }) }
      return removed.kind === "file"
        ? { ok: true, kind: "file", target: removed.path, ...recovery, ...reached }
        : { ok: true, kind: "task", target: removed.name, ...recovery, ...reached }
    } finally {
      fence?.release()
      if (held) this.deps.daemon.endHandoff()
      this.#busy = false
    }
  }

  // The app is attached to the service, so there is no daemon of its own to
  // stop. Reconnects are held while the service restarts on the new runtime.
  async update(): Promise<DaemonServiceOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", message: "A service change is already in progress." }
    this.#busy = true
    let held = false
    let fence: { release: () => void } | undefined
    let prepared: PreparedDaemonRuntime | undefined
    try {
      const refused = (await this.#profileRefusal()) ?? (await this.#refusal())
      if (refused) return refused
      // Owner ruling 2026-09-26 (#577, A): the daemon's own fence, as install
      // and remove take it. The read above is only a snapshot; a turn can start
      // after it. Security review of #577 (P2): taken before staging, because
      // staging replaces the copy of this version under the profile, which the
      // running service may be using; no turn starts on it once fenced.
      const fenced = await this.#fence()
      if (!("release" in fenced)) return fenced
      fence = fenced
      let updated: DaemonServiceInstallResult
      try {
        prepared = await this.deps.stageRuntime("update")
        held = true
        this.deps.daemon.beginHandoff()
        updated = await this.deps.update({ runtime: prepared.runtime, staged: { runtime: prepared.staged, publish: prepared.publish } })
      } catch (cause) {
        const missing = runtimeMissing(cause)
        if (missing) return { ok: false, reason: "runtime-missing", ...missing }
        const otherProfile = profileRefusal(cause)
        if (otherProfile) return { ok: false, reason: "refused", message: otherProfile }
        return { ok: false, reason: "update-failed", message: message(cause) }
      }
      const target = updated.kind === "file" ? updated.path : updated.name
      let attached: DesktopDaemonAcquisition
      try {
        attached = await this.deps.daemon.attachOnly()
      } catch (cause) {
        return { ok: false, reason: "installed-not-attached", kind: updated.kind, target, message: message(cause) }
      }
      if (attached.kind === "refused") {
        return { ok: false, reason: "installed-not-attached", kind: updated.kind, target, message: attached.message }
      }
      // As security review round 9 ruled for install: reaching a daemon is not
      // proof the updated service runs it.
      if (attached.kind !== "attached" || attached.owner !== "daemon" || !(await this.#serviceRuns())) {
        return { ok: false, reason: "installed-not-attached", kind: updated.kind, target, message: "The daemon this window reached is not the running service." }
      }
      return { ok: true, kind: updated.kind, target, configurationPath: updated.configurationPath, daemonRunning: true }
    } finally {
      fence?.release()
      if (held) this.deps.daemon.endHandoff()
      this.#busy = false
    }
  }

  async #profileRefusal(): Promise<DaemonServiceOutcome | undefined> {
    try {
      const mismatch = await this.deps.profile()
      if (!mismatch) return undefined
      return { ok: false, reason: "refused", message: `This app's daemon uses the profile at ${mismatch.app}, and the login service uses the profile at ${mismatch.service}.` }
    } catch (cause) {
      return { ok: false, reason: "check-failed", message: message(cause) }
    }
  }

  async #refusal(): Promise<DaemonServiceOutcome | undefined> {
    try {
      const refusal = await this.deps.refusal()
      return refusal === undefined ? undefined : { ok: false, reason: "refused", message: refusal }
    } catch (cause) {
      return { ok: false, reason: "check-failed", message: message(cause) }
    }
  }

  // The same answers as the first check: the refusal, or not knowing.
  async #fence(): Promise<{ release: () => void } | DaemonServiceOutcome> {
    try {
      const fence = await this.deps.fence()
      return "release" in fence ? fence : { ok: false, reason: "refused", message: fence.refusal }
    } catch (cause) {
      return { ok: false, reason: "check-failed", message: message(cause) }
    }
  }

  async #serviceRuns(): Promise<boolean> {
    try {
      const status = await this.deps.status()
      return status.installed === true && status.running
    } catch {
      return false
    }
  }

  async #serviceAfter(): Promise<ServiceReadBack | null> {
    try {
      const status = await this.deps.status()
      return { installed: status.installed, running: status.running }
    } catch {
      return null
    }
  }

  // The daemon this app reaches once the handoff is over: its own started
  // again, one it did not start (attached), or none.
  async #daemonAfter(): Promise<"restarted" | "attached" | "stopped"> {
    try {
      const acquired = await this.deps.daemon.restart()
      return acquired.kind === "owned" ? "restarted" : acquired.kind === "attached" ? "attached" : "stopped"
    } catch {
      return "stopped"
    }
  }
}
