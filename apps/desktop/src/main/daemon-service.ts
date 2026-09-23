import { DaemonServiceRuntimeMissingError, type DaemonServiceInstallResult, type DaemonServiceOptions, type DaemonServiceRemovalResult, type DaemonServiceRuntime, type DaemonServiceStatus } from "@getdomovoi/daemon"
import { posix, win32 } from "node:path"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

// J24 (2026-09-23): keep Domovoi running after the app quits. The app ships
// Node and the daemon under its resources, copies them under the profile so
// the service outlives app updates and moves, and asks the daemon's own
// installer to register a per-user service pointing at that copy. The
// installer stops the in-app daemon only after its checks pass, through
// releaseInAppDaemon, so a bad runtime never interrupts anything. The
// renderer refuses the handoff while a turn runs or a gate waits; nothing
// here looks at sessions.

export type DaemonServiceOutcome =
  | { ok: true; kind: "file" | "task"; target: string; configurationPath: string }
  | { ok: true; kind: "file" | "task"; target: string; profileRecovery: DaemonServiceRemovalResult["profileRecovery"]; profileRecoveryDetail?: string }
  | { ok: false; reason: "runtime-missing"; part: "node" | "daemon"; path: string; message: string }
  | { ok: false; reason: "busy"; message: string }
  | { ok: false; reason: "failed"; message: string; restarted: boolean }

export type DaemonServiceStatusReport = DaemonServiceStatus | { unavailable: string }

export type DesktopDaemonServiceDependencies = {
  // Copies the shipped runtime under the profile and names the copy, or
  // throws DaemonServiceRuntimeMissingError naming the part that is not there.
  stageRuntime: () => Promise<DaemonServiceRuntime>
  install: (options: DaemonServiceOptions) => Promise<DaemonServiceInstallResult>
  status: () => Promise<DaemonServiceStatus>
  remove: () => Promise<DaemonServiceRemovalResult>
  daemon: {
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
// before any byte is copied, so a half-shipped app installs nothing.
export async function stageDaemonRuntime(input: {
  resourcesPath: string
  home: string
  version: string
  platform: string
  exists: (path: string) => Promise<boolean>
  copy: (from: string, to: string) => Promise<void>
}): Promise<DaemonServiceRuntime> {
  const shipped = daemonRuntimeLayout(input.resourcesPath, input.platform)
  for (const [part, path] of [["node", shipped.nodePath], ["daemon", shipped.daemonEntryPath]] as const) {
    if (!(await input.exists(path))) throw new DaemonServiceRuntimeMissingError(part, path, "missing")
  }
  const pathApi = input.platform === "win32" ? win32 : posix
  const destination = profileRuntimeDirectory(input.home, input.version, input.platform)
  await input.copy(pathApi.join(input.resourcesPath, runtimeDirectory), destination)
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
      const runtime = await this.deps.stageRuntime()
      const installed = await this.deps.install({
        runtime,
        releaseInAppDaemon: async () => {
          released = true
          await this.deps.daemon.stopOwned()
        },
      })
      const attached = await this.deps.daemon.attachOnly()
      if (attached.kind === "refused") {
        return { ok: false, reason: "failed", message: `The service was installed, but this app could not attach to it: ${attached.message}`, restarted: false }
      }
      return installed.kind === "file"
        ? { ok: true, kind: "file", target: installed.path, configurationPath: installed.configurationPath }
        : { ok: true, kind: "task", target: installed.name, configurationPath: installed.configurationPath }
    } catch (cause) {
      if (cause instanceof DaemonServiceRuntimeMissingError) {
        return { ok: false, reason: "runtime-missing", part: cause.part, path: cause.path, message: cause.message }
      }
      let restarted = false
      if (released) {
        // The stop happened and the install did not finish: the profile is
        // free, so the app takes its daemon back rather than sit idle.
        restarted = (await this.deps.daemon.restart()).kind === "owned"
      }
      return { ok: false, reason: "failed", message: message(cause), restarted }
    } finally {
      this.#busy = false
    }
  }

  async remove(): Promise<DaemonServiceOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", message: "A service change is already in progress." }
    this.#busy = true
    try {
      const removed = await this.deps.remove()
      await this.deps.daemon.restart()
      const recovery = { profileRecovery: removed.profileRecovery, ...(removed.profileRecoveryDetail === undefined ? {} : { profileRecoveryDetail: removed.profileRecoveryDetail }) }
      return removed.kind === "file"
        ? { ok: true, kind: "file", target: removed.path, ...recovery }
        : { ok: true, kind: "task", target: removed.name, ...recovery }
    } catch (cause) {
      return { ok: false, reason: "failed", message: message(cause), restarted: false }
    } finally {
      this.#busy = false
    }
  }
}
