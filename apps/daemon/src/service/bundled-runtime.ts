import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { posix, win32 } from "node:path"

import type { DaemonEnvironment } from "../config.js"
import type { DaemonServiceRuntime } from "./desktop-service.js"
import { DaemonServiceRuntimeMissingError, daemonRuntimeLayout, nodeRuntimeFileSystem, prepareDaemonRuntime, type RuntimeFileSystem } from "./runtime-stage.js"

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
export function unstableAppLocation(resources: string, environment: DaemonEnvironment): string | undefined {
  const where = "so its commands are not where a login service can keep running them."
  if (environment.APPIMAGE !== undefined || /(?:^|[\\/])\.mount_[^\\/]*(?:[\\/]|$)/u.test(resources)) {
    return `Domovoi is running as an AppImage, which mounts at a new path on every launch, ${where} Use Install under Daemon on this machine in Settings, which copies the runtime out of the AppImage. Nothing was installed.`
  }
  if (resources.includes("/AppTranslocation/")) {
    return `macOS is running Domovoi from a temporary copy, ${where} Move Domovoi to Applications and open it once from there, then run this again, or ${inAppInstall}. Nothing was installed.`
  }
  if (resources.startsWith("/Volumes/")) {
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
  publish: () => Promise<void>
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
  fileSystem?: RuntimeFileSystem
  stagingParent?: string
}): Promise<BundledServiceRuntime | undefined> {
  const resources = appRuntimeResources(input.execPath, input.platform)
  if (resources === undefined) return undefined
  const unstable = unstableAppLocation(resources, input.environment)
  if (unstable) throw new Error(unstable)
  if (input.version === undefined) throw new Error("This domovoid could not read its own version, so no runtime was copied. Nothing was installed.")
  const base = input.fileSystem ?? nodeRuntimeFileSystem()
  // The private staging directory this run makes, by path and by the device
  // and inode it had when made.
  let made: { path: string; identity: string } | undefined
  const fileSystem: RuntimeFileSystem = {
    ...base,
    makePrivateDirectory: async (prefix) => {
      const path = await base.makePrivateDirectory(prefix)
      made = { path, identity: await base.identity(path) }
      return path
    },
  }
  const prefix = `.domovoi-runtime-${input.version}.staging-`
  const paths = input.platform === "win32" ? win32 : posix
  // Requested 2026-10-02 before review: unlike the app, which leaves its
  // staging directory (runtime-stage.ts, round 8), a terminal install removes
  // it, with any partial copy in it. Only that directory, and only while it is
  // still the one this run made: a real directory (never a link), with the
  // device and inode it was made with, named with this prefix and inside the
  // system temporary directory. fs.rm removes a link inside it as a link and
  // never follows it. Limit, as round 8 says: Node cannot bind this check to
  // the removal, so a directory a process of the same user swaps in between
  // would be removed instead.
  const removeStaging = async () => {
    const holder = made
    made = undefined
    if (holder === undefined) return
    try {
      if (await base.entry(holder.path) !== "directory" || await base.identity(holder.path) !== holder.identity) return
      if (!paths.basename(holder.path).startsWith(prefix)) return
      const relative = paths.relative(await base.realpath(tmpdir()), await base.realpath(holder.path))
      if (relative === "" || relative.split(paths.sep)[0] === ".." || paths.isAbsolute(relative)) return
      await rm(holder.path, { recursive: true, force: false })
    } catch {
      // Left as the app leaves it: only disk space.
    }
  }
  const prepared = await prepareDaemonRuntime({
    resourcesPath: resources,
    profileDirectory: input.profileDirectory,
    version: input.version,
    platform: input.platform,
    fileSystem,
    ...(input.stagingParent === undefined ? {} : { stagingParent: input.stagingParent }),
  })
  return {
    runtime: prepared.runtime,
    copy: paths.dirname(paths.dirname(paths.dirname(prepared.runtime.daemonEntryPath))),
    publish: async () => {
      try {
        await prepared.publish()
      } finally {
        await removeStaging()
      }
      for (const [part, path] of [["node", prepared.runtime.nodePath], ["daemon", prepared.runtime.daemonEntryPath]] as const) {
        const found = await fileSystem.entry(path)
        if (found !== "file") throw new DaemonServiceRuntimeMissingError(part, path, found === "missing" ? "missing" : "not-file")
      }
    },
  }
}
