import { DaemonServiceRuntimeMissingError, type DaemonServiceInstallResult, type DaemonServiceOptions, type DaemonServiceRemovalResult, type DaemonServiceRuntime, type DaemonServiceStatus } from "@getdomovoi/daemon"
import { publishFileDurably } from "@getdomovoi/credential-store"
import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readdir, readlink, realpath, rm } from "node:fs/promises"
import { posix, win32 } from "node:path"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

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

export type ServiceReadBack = { installed: boolean | null; running: boolean }

export type DaemonServiceStatusReport = DaemonServiceStatus | { unavailable: string }

export type ServiceHandoffFence = { refusal: string } | { release: () => void }

export type DesktopDaemonServiceDependencies = {
  // Copies the shipped runtime under the profile and names the copy, or
  // throws DaemonServiceRuntimeMissingError naming the part that is not there.
  stageRuntime: () => Promise<DaemonServiceRuntime>
  install: (options: DaemonServiceOptions) => Promise<DaemonServiceInstallResult>
  status: () => Promise<DaemonServiceStatus>
  remove: () => Promise<DaemonServiceRemovalResult>
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
export function profileRuntimeDirectory(home: string, version: string, platform: string): string {
  const path = platform === "win32" ? win32 : posix
  if (version.length > maximumRuntimeVersionLength || !runtimeVersionPattern.test(version)) {
    throw new Error(`The app version "${version.slice(0, maximumRuntimeVersionLength)}" is not a release version, so no runtime was copied.`)
  }
  const root = path.join(home, ".domovoi", "runtime")
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
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
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
    remove: (path) => rm(path, { recursive: true, force: true }),
    // Each rename is followed by a flush of the directory that holds it.
    rename: (from, to) => publishFileDurably(from, to),
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
async function checkShippedRuntime(fs: RuntimeFileSystem, pathApi: typeof posix, shippedRoot: string, platform: string): Promise<void> {
  const shipped = daemonRuntimeLayout(pathApi.dirname(shippedRoot), platform)
  for (const [part, path] of [["node", shipped.nodePath], ["daemon", shipped.daemonEntryPath]] as const) {
    const steps = pathApi.relative(shippedRoot, path).split(pathApi.sep)
    let at = shippedRoot
    for (const [index, step] of ["", ...steps].entries()) {
      at = step === "" ? at : pathApi.join(at, step)
      const found = await fs.entry(at)
      if (found === "missing") throw new DaemonServiceRuntimeMissingError(part, path, "missing")
      if (found !== (index === steps.length ? "file" : "directory")) throw new DaemonServiceRuntimeMissingError(part, path, "not-file")
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

// ~/.domovoi and ~/.domovoi/runtime must be real directories owned by this
// profile: a link there would send the copy, and the replacement of an
// earlier copy, somewhere else. Missing ones are made, private to the user.
async function runtimeRoot(fs: RuntimeFileSystem, pathApi: typeof posix, home: string): Promise<string> {
  let at = home
  for (const step of [".domovoi", "runtime"]) {
    at = pathApi.join(at, step)
    if (await fs.entry(at) === "missing") await fs.makeDirectory(at)
    if (await fs.entry(at) !== "directory") {
      throw new Error(`${at} is not a directory (it may be a link), so no runtime was copied under it.`)
    }
  }
  if (await fs.realpath(at) !== pathApi.join(await fs.realpath(home), ".domovoi", "runtime")) {
    throw new Error(`${at} does not resolve inside the home directory, so no runtime was copied under it.`)
  }
  return at
}

// The copy under the profile outlives app updates and moves; the service
// points at it, never into the app bundle. The shipped runtime and the
// profile's runtime directory are checked before any byte is copied, so a
// half-shipped app or a redirected profile installs nothing. The copy is made
// in a fresh directory beside the destination. An earlier copy of the same
// version is moved aside, the new one renamed into place, and only then the
// earlier one deleted.
//
// Security review round 2: a durable rename moves, then flushes the directory,
// and the flush can throw after the move is done. The rule: a staging that
// reports failure leaves the version path as it was before, with the earlier
// copy there or nothing there. What moved is read back from the disk, never
// inferred from which call threw.
export async function stageDaemonRuntime(input: {
  resourcesPath: string
  home: string
  version: string
  platform: string
  fileSystem: RuntimeFileSystem
}): Promise<DaemonServiceRuntime> {
  const fs = input.fileSystem
  const pathApi = input.platform === "win32" ? win32 : posix
  const destination = profileRuntimeDirectory(input.home, input.version, input.platform)
  const shippedRoot = pathApi.join(input.resourcesPath, runtimeDirectory)
  await checkShippedRuntime(fs, pathApi, shippedRoot, input.platform)
  const root = await runtimeRoot(fs, pathApi, input.home)
  const earlier = await fs.entry(destination)
  if (earlier !== "missing" && earlier !== "directory") {
    throw new Error(`${destination} is not a directory (it may be a link), so no runtime was copied there.`)
  }
  const staging = pathApi.join(root, `.${input.version}.staging-${randomUUID()}`)
  const aside = pathApi.join(root, `.${input.version}.previous-${randomUUID()}`)
  const failed = pathApi.join(root, `.${input.version}.failed-${randomUUID()}`)
  // Whether the move aside is known to have happened: its call returned.
  let asideMoved = false
  try {
    await fs.copy(shippedRoot, staging)
    if (earlier === "directory") {
      await fs.rename(destination, aside)
      asideMoved = true
    }
    await fs.rename(staging, destination)
  } catch (cause) {
    await restoreVersionPath(fs, { destination, aside, failed, hadEarlier: earlier === "directory", asideMoved })
    throw cause
  } finally {
    // Cleanup only: a staging directory left behind is disk space. Its
    // failure must not replace the publish's own error, nor turn a completed
    // publish into a reported failure.
    await fs.remove(staging).catch(() => {})
  }
  if (earlier === "directory") {
    // The new copy is in place. An earlier copy left behind here is only
    // disk space, never something the service runs.
    await fs.remove(aside).catch(() => {})
  }
  return {
    nodePath: input.platform === "win32" ? pathApi.join(destination, "node", "node.exe") : pathApi.join(destination, "node", "bin", "node"),
    daemonEntryPath: pathApi.join(destination, "daemon", "dist", "index.js"),
  }
}

// Undo whatever part of a failed publish completed. The version path was
// either the earlier copy or empty before; a directory there now that is not
// the earlier copy is the new one, published by a rename whose flush threw.
// Final review round 3: the new copy is renamed out to a fresh `failed` name
// (one atomic step that can be read back), the earlier copy renamed back, and
// only then the moved-out copy removed, best effort. A remove that fails part
// way therefore leaves a hidden leftover, never a partial copy at the version
// path. Nothing here throws: each step's error is ignored and the next state
// read from disk, and a read that fails counts as not known. The caller keeps
// the error that stopped the publish. If the earlier copy cannot be put back,
// it stays at `aside`.
async function restoreVersionPath(fs: RuntimeFileSystem, paths: {
  destination: string
  aside: string
  failed: string
  hadEarlier: boolean
  asideMoved: boolean
}): Promise<void> {
  const settled = async (step: () => Promise<void>) => { try { await step() } catch { /* read back below */ } }
  const read = async (path: string): Promise<RuntimeEntry | undefined> => { try { return await fs.entry(path) } catch { return undefined } }
  if (paths.hadEarlier && !paths.asideMoved) {
    // The move aside threw. If the earlier copy is not known to be aside, it
    // may still be at the version path, which must then not be touched.
    const aside = await read(paths.aside)
    if (aside === "missing" || aside === undefined) return
  }
  // The version path holds nothing of the earlier copy now, so whatever is
  // there is the new copy. A read that fails still tries the rename, which
  // does nothing when the path is empty.
  if (await read(paths.destination) !== "missing") await settled(() => fs.rename(paths.destination, paths.failed))
  if (paths.hadEarlier) {
    const now = await read(paths.destination)
    if (now === "missing" || now === undefined) await settled(() => fs.rename(paths.aside, paths.destination))
  }
  if (await read(paths.failed) !== "missing") await settled(() => fs.remove(paths.failed))
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
    try {
      const refused = await this.#refusal()
      if (refused) return refused
      let installed: DaemonServiceInstallResult
      try {
        const runtime = await this.deps.stageRuntime()
        installed = await this.deps.install({
          runtime,
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
        if (cause instanceof DaemonServiceRuntimeMissingError) {
          return { ok: false, reason: "runtime-missing", part: cause.part, path: cause.path, message: cause.message }
        }
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
      const refused = await this.#refusal()
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
