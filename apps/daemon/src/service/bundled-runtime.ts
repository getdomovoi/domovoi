import { tmpdir } from "node:os"
import { posix, win32 } from "node:path"

import type { DaemonEnvironment } from "../config.js"
import type { OperationDeadline } from "../operation-deadline.js"
import type { FileLease } from "../file-lease.js"
import { nodeDaemonServiceRuntimeReader, readDaemonServiceRuntimeCopy, type DaemonServiceRuntime, type DaemonServiceRuntimeCopy, type DaemonServiceRuntimeReader } from "./desktop-service.js"
import { removeUnusedDaemonRuntimes, type DaemonRuntimeCleanupDependencies } from "./runtime-cleanup.js"
import { DaemonRuntimeStagingRefusedError, DaemonServiceRuntimeMissingError, daemonRuntimeLayout, nodeRuntimeFileSystem, prepareDaemonRuntime, type RuntimeFileSystem } from "./runtime-stage.js"

// Q408 A (2026-10-02): `domovoid service install` run from the runtime the
// Domovoi app ships (its launcher in <resources>/daemon-runtime/bin runs
// <resources>/daemon-runtime/daemon/dist/index.js) would point the service
// into the app, which breaks once the app moves, updates or is deleted. It
// makes the same copy under the profile as the app's Install
// (prepareDaemonRuntime), publishes it under the service-operation lease and
// points the service at the copy. A run from an installed copy
// (<profile>/runtime/<version>/<id>) or from a checkout or package install
// is not inside an app and installs as before.

// The app's resources directory when execPath is the daemon entry of the
// runtime an app ships, else undefined.
export function appRuntimeResources(execPath: string, platform: string): string | undefined {
  const paths = platform === "win32" ? win32 : posix
  if (!paths.isAbsolute(execPath)) return undefined
  const resources = paths.dirname(paths.dirname(paths.dirname(paths.dirname(execPath))))
  const expected = daemonRuntimeLayout(resources, platform).daemonEntryPath
  const same = platform === "win32" ? expected.toLowerCase() === execPath.toLowerCase() : expected === execPath
  return same ? resources : undefined
}

const inAppInstall = "use Install under Daemon on this machine in Settings"

// An app running from a path that will not be there once it quits: macOS App
// Translocation's temporary copy, a mounted disk image, and an AppImage,
// which mounts at a new path on every launch. The desktop offers no command
// links there either (apps/desktop/src/main/command-links.ts).
//
// Review of #712 (P2): an external drive also mounts under /Volumes, and an
// app kept there stays at its path. A /Volumes path is a disk image only when
// it is on a read-only mount (readOnlyMount, runtime-stage.ts), as the
// downloaded disk image is; a writable disk image is not caught.
export async function unstableAppLocation(resources: string, environment: DaemonEnvironment, readOnly: (path: string) => Promise<boolean>): Promise<string | undefined> {
  const where = "so its commands are not where a login service can keep running them."
  if (environment.APPIMAGE !== undefined || /(?:^|[\\/])\.mount_[^\\/]*(?:[\\/]|$)/u.test(resources)) {
    return `Domovoi is running as an AppImage, which mounts at a new path on every launch, ${where} Use Install under Daemon on this machine in Settings, which copies the runtime out of the AppImage. Nothing was installed.`
  }
  if (resources.includes("/AppTranslocation/")) {
    return `macOS is running Domovoi from a temporary copy, ${where} Move Domovoi to Applications and open it once from there, then run this again, or ${inAppInstall}. Nothing was installed.`
  }
  if (resources.startsWith("/Volumes/") && await readOnly(resources)) {
    return `Domovoi is running from a disk image, ${where} Copy Domovoi to Applications and run this again from there, or ${inAppInstall}. Nothing was installed.`
  }
  return undefined
}

export type BundledServiceRuntime = {
  // The copy the service will run, and the directory that holds it.
  runtime: DaemonServiceRuntime
  copy: string
  // Run by the installer under its service-operation lease, after its profile
  // checks: writes the copy, then checks both parts are files there.
  //
  // By design it leaves its private staging directory in the system
  // temporary directory, or in <state>/domovoi/runtime-staging when that is
  // where it staged, as the app's Install does: empty after a publish,
  // holding the partial copy after a failure. Security review round 8 of #577
  // (P2, runtime-stage.ts): Node cannot remove a directory relative to one it
  // holds open, so a check that the path is still that directory cannot be
  // bound to its removal, and a directory swapped in between would be removed
  // instead. It is only disk space.
  publish: (deadline?: OperationDeadline) => Promise<void>
  // #635, as the app's Install does: run once the new service is installed.
  // Removes the copies under the profile that neither the service now nor the
  // one before this install runs (removeUnusedDaemonRuntimes, under its own
  // service-operation lease), only when this install published its copy and
  // read what the service ran before. A failure keeps the copies and changes
  // nothing about the install; the next one tries again.
  removeUnused: () => Promise<void>
}

// Where the command stages the copy when the system temporary directory is
// on another volume from the profile, as a tmpfs /tmp is on Fedora, Arch and
// Debian 13 with TMPDIR unset. The app's Install stages under its data
// directory there; the command has none, so it uses the XDG state directory,
// on the home volume and outside every profile and repository by default.
// prepareDaemonRuntime checks it as it checks the app's data directory and
// stages in its runtime-staging. A relative XDG_STATE_HOME is ignored, as the
// XDG Base Directory Specification says. Windows keeps only the system
// temporary directory, which is under the user's profile there.
function commandStateDirectory(environment: DaemonEnvironment, home: string, platform: string): string | undefined {
  if (platform === "win32") return undefined
  const configured = environment.XDG_STATE_HOME
  const state = configured !== undefined && posix.isAbsolute(configured) ? configured : posix.join(home, ".local", "state")
  return posix.join(state, "domovoi")
}

// Names the directory under the state directory that failed (an ancestor,
// the state directory itself or its runtime-staging), and says "Nothing was
// changed" only when no directory was made before the refusal.
function commandStagingRefusal(refused: DaemonRuntimeStagingRefusedError, dataDirectory: string | undefined, platform: string): string {
  const outcome = refused.made.length === 0
    ? "Nothing was changed."
    : `It made ${refused.made.join(", ")}, which hold no files, and changed nothing else.`
  // PR #712 security review round 2 (P2): a place another account could
  // change is refused too (unprotectedStagingDirectory, runtime-stage.ts).
  // Windows cannot be asked that, so there the place must be inside this
  // user's profile.
  const who = platform === "win32" ? "inside your user profile" : "that no other account can change"
  const where = `on the same volume as the profile directory ${refused.profileDirectory} and outside every profile and repository`
  const failed = refused.failed ?? dataDirectory
  // Q413 A: when the access gate failed that directory, what fixes it. The
  // chmod is offered only for this user's own directory, where it works; a
  // directory another account owns only that account could change.
  const access = refused.access?.path === failed ? refused.access?.access : undefined
  const owner = access === "another-account" ? `${failed} belongs to another account. ` : ""
  const chmod = access === "own-writable" && failed !== undefined ? `Run chmod go-w ${shellWord(failed)} and try again. ` : ""
  return failed === undefined
    ? `The runtime could not be copied out of the app: the system temporary directory, ${tmpdir()}, must be a directory, not a link, ${who}, ${where}, and it is not. Set ${platform === "win32" ? "TEMP" : "TMPDIR"} to a directory that is, and run this again. ${outcome}`
    : `The runtime could not be copied out of the app: the system temporary directory, ${tmpdir()}, and ${failed} must each be a directory, not a link, ${who}, ${where}, and neither is. ${owner}Set TMPDIR or XDG_STATE_HOME to a directory that is, and run this again. ${chmod}${outcome}`
}

// A path as one POSIX shell word: as it is when it holds only characters a
// shell leaves alone, else in single quotes, each ' written as '\''.
function shellWord(path: string): string {
  return /^[A-Za-z0-9_./+:@%-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

// The copy to install from when execPath is an app's runtime, or undefined.
// Throws, before anything is written, for an app at an unstable location, a
// runtime missing a part or a profile that cannot hold the copy.
export async function bundledServiceRuntime(input: {
  execPath: string
  platform: string
  environment: DaemonEnvironment
  // The profile the service runs, where the copy goes.
  profileDirectory: string
  // This daemon's version, which names the copy's directory.
  version: string | undefined
  // The home directory, under which the state directory is by default.
  home: string
  fileSystem?: RuntimeFileSystem
  stagingParent?: string
  // The service-operation lease the cleanup takes, the installer's own.
  claimServiceOperation: () => FileLease
  // What reads the service definition, before the publish and again in the
  // cleanup; by default the app's reader, for this home and platform.
  reader?: DaemonServiceRuntimeReader
}): Promise<BundledServiceRuntime | undefined> {
  const resources = appRuntimeResources(input.execPath, input.platform)
  if (resources === undefined) return undefined
  const fileSystem = input.fileSystem ?? nodeRuntimeFileSystem()
  const unstable = await unstableAppLocation(resources, input.environment, (path) => fileSystem.readOnly(path))
  if (unstable) throw new Error(unstable)
  if (input.version === undefined) throw new Error("This domovoid could not read its own version, so no runtime was copied. Nothing was installed.")
  const paths = input.platform === "win32" ? win32 : posix
  const dataDirectory = commandStateDirectory(input.environment, input.home, input.platform)
  const worded = (error: unknown) => error instanceof DaemonRuntimeStagingRefusedError
    ? new Error(commandStagingRefusal(error, dataDirectory, input.platform))
    : error
  const prepared = await prepareDaemonRuntime({
    resourcesPath: resources,
    profileDirectory: input.profileDirectory,
    version: input.version,
    platform: input.platform,
    fileSystem,
    ...(input.stagingParent === undefined ? {} : { stagingParent: input.stagingParent }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }).catch((error: unknown) => { throw worded(error) })
  // As the app's Install notes them (apps/desktop/src/main/daemon-service.ts):
  // what the service ran, read under this install's lease right before the
  // publish, and whether the publish happened. A read that fails leaves the
  // previous copy unknown, and then no cleanup runs.
  let previous: DaemonServiceRuntimeCopy | undefined
  let published = false
  const cleanup: DaemonRuntimeCleanupDependencies = {
    ...(input.reader ?? { ...nodeDaemonServiceRuntimeReader(), platform: input.platform, home: input.home }),
    claimServiceOperation: input.claimServiceOperation,
  }
  return {
    runtime: prepared.runtime,
    copy: paths.dirname(paths.dirname(paths.dirname(prepared.runtime.daemonEntryPath))),
    publish: async (deadline) => {
      try {
        previous = await readDaemonServiceRuntimeCopy(cleanup)
      } catch {
        previous = undefined
      }
      await prepared.publish(deadline).catch((error: unknown) => { throw worded(error) })
      published = true
      for (const [part, path] of [["node", prepared.runtime.nodePath], ["daemon", prepared.runtime.daemonEntryPath]] as const) {
        const found = await fileSystem.entry(path)
        if (found !== "file") throw new DaemonServiceRuntimeMissingError(part, path, found === "missing" ? "missing" : "not-file")
      }
    },
    removeUnused: async () => {
      if (!published || previous === undefined) return
      try {
        await removeUnusedDaemonRuntimes({ profileDirectory: input.profileDirectory, published: prepared.runtime, previous }, cleanup)
      } catch {
        // Kept: the next confirmed install tries again.
      }
    },
  }
}
