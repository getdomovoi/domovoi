import { DaemonServiceRuntimeMissingError, type DaemonServiceInstallResult, type DaemonServiceOptions, type DaemonServiceRemovalResult, type DaemonServiceRuntime, type DaemonServiceStatus } from "@getdomovoi/daemon"
import { randomUUID } from "node:crypto"
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
  | { ok: true; kind: "file" | "task"; target: string; profileRecovery: DaemonServiceRemovalResult["profileRecovery"]; profileRecoveryDetail?: string; daemonRunning: boolean }
  | { ok: false; reason: "runtime-missing"; part: "node" | "daemon"; path: string; message: string }
  // The service is installed and this app's daemon is stopped, but the app
  // could not attach to the service. It does not start its own daemon again:
  // the service may hold the profile.
  | { ok: false; reason: "installed-not-attached"; kind: "file" | "task"; target: string; message: string }
  | { ok: false; reason: "busy" | "refused" | "check-failed"; message: string }
  // What became of the app's own daemon: never stopped, started again, or
  // stopped and not back.
  | { ok: false; reason: "failed"; message: string; daemon: "untouched" | "restarted" | "stopped" }

export type DaemonServiceStatusReport = DaemonServiceStatus | { unavailable: string }

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

export function profileRuntimeDirectory(home: string, version: string, platform: string): string {
  const path = platform === "win32" ? win32 : posix
  return path.join(home, ".domovoi", "runtime", version)
}

// The copy under the profile outlives app updates and moves; the service
// points at it, never into the app bundle. Both shipped parts are checked
// before any byte is copied, so a half-shipped app installs nothing. The copy
// is made in a fresh directory beside the destination and renamed over it, so
// an earlier copy of the same version leaves no stale file behind, and a copy
// that fails leaves the earlier one as it was.
export async function stageDaemonRuntime(input: {
  resourcesPath: string
  home: string
  version: string
  platform: string
  exists: (path: string) => Promise<boolean>
  copy: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}): Promise<DaemonServiceRuntime> {
  const shipped = daemonRuntimeLayout(input.resourcesPath, input.platform)
  for (const [part, path] of [["node", shipped.nodePath], ["daemon", shipped.daemonEntryPath]] as const) {
    if (!(await input.exists(path))) throw new DaemonServiceRuntimeMissingError(part, path, "missing")
  }
  const pathApi = input.platform === "win32" ? win32 : posix
  const destination = profileRuntimeDirectory(input.home, input.version, input.platform)
  const staging = pathApi.join(pathApi.dirname(destination), `.${pathApi.basename(destination)}.staging-${randomUUID()}`)
  try {
    await input.copy(pathApi.join(input.resourcesPath, runtimeDirectory), staging)
    await input.remove(destination)
    await input.rename(staging, destination)
  } finally {
    await input.remove(staging)
  }
  return {
    nodePath: input.platform === "win32" ? pathApi.join(destination, "node", "node.exe") : pathApi.join(destination, "node", "bin", "node"),
    daemonEntryPath: pathApi.join(destination, "daemon", "dist", "index.js"),
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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
    try {
      const refused = await this.#refusal()
      if (refused) return refused
      let installed: DaemonServiceInstallResult
      try {
        const runtime = await this.deps.stageRuntime()
        installed = await this.deps.install({
          runtime,
          releaseInAppDaemon: async () => {
            released = true
            this.deps.daemon.beginHandoff()
            await this.deps.daemon.stopOwned()
          },
        })
      } catch (cause) {
        if (cause instanceof DaemonServiceRuntimeMissingError) {
          return { ok: false, reason: "runtime-missing", part: cause.part, path: cause.path, message: cause.message }
        }
        // The stop happened and the install did not finish: the profile is
        // free, so the app takes its daemon back rather than sit idle.
        const daemon = released ? ((await this.#restarted()) ? "restarted" : "stopped") : "untouched"
        return { ok: false, reason: "failed", message: message(cause), daemon }
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
      if (released) this.deps.daemon.endHandoff()
      this.#busy = false
    }
  }

  async remove(): Promise<DaemonServiceOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", message: "A service change is already in progress." }
    this.#busy = true
    let held = false
    try {
      const refused = await this.#refusal()
      if (refused) return refused
      held = true
      this.deps.daemon.beginHandoff()
      const removed = await this.deps.remove()
      const daemonRunning = await this.#restarted()
      const recovery = { profileRecovery: removed.profileRecovery, ...(removed.profileRecoveryDetail === undefined ? {} : { profileRecoveryDetail: removed.profileRecoveryDetail }) }
      return removed.kind === "file"
        ? { ok: true, kind: "file", target: removed.path, ...recovery, daemonRunning }
        : { ok: true, kind: "task", target: removed.name, ...recovery, daemonRunning }
    } catch (cause) {
      return { ok: false, reason: "failed", message: message(cause), daemon: "untouched" }
    } finally {
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

  async #restarted(): Promise<boolean> {
    try {
      return (await this.deps.daemon.restart()).kind === "owned"
    } catch {
      return false
    }
  }
}
