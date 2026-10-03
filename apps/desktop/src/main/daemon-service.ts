import type { DaemonServiceInstallResult, DaemonServiceOptions, DaemonServiceRemovalResult, DaemonServiceRuntime, DaemonServiceRuntimeCopy, DaemonServiceStagedRuntime, DaemonServiceStatus, PreparedDaemonRuntime } from "@getdomovoi/daemon"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

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
  // lingerWarning: the daemon's own warning that Linux lingering could not be
  // turned on (ruling Q307), shown with the install result.
  | { ok: true; kind: "file" | "task"; target: string; configurationPath: string; daemonRunning: true; lingerWarning?: string }
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
  // #635: the published runtime copy the login service definition names
  // (readDaemonServiceRuntimeCopy). Read inside the publish, which the service
  // calls run under their service-operation lease before they write the new
  // definition, so it is the copy the service ran before this change. Throws
  // when it cannot be read.
  runtimeCopy: () => Promise<DaemonServiceRuntimeCopy>
  // #635: removes the copies under the profile that neither the definition
  // now nor the one before this change names, under the service-operation
  // lease (removeUnusedDaemonRuntimes). Its answer is not shown.
  removeUnusedRuntimes: (options: { published: DaemonServiceRuntime; previous: DaemonServiceRuntimeCopy }) => Promise<unknown>
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

// The runtime copy under the profile (prepareDaemonRuntime and the file
// system it uses) moved to the daemon (service/runtime-stage.ts, Q408 A), so
// `domovoid service install` run from the app's runtime makes the same copy.
// The app calls it through the daemon module it loads at run time.

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// #635: what the publish of one change saw: the copy the service ran before
// it, when that could be read, and whether the publish completed.
type NotedRuntimeCopy = { previous?: DaemonServiceRuntimeCopy; published?: true }

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
    const noted: NotedRuntimeCopy = {}
    try {
      const refused = (await this.#profileRefusal()) ?? (await this.#refusal())
      if (refused) return refused
      let installed: DaemonServiceInstallResult
      try {
        prepared = await this.deps.stageRuntime("install")
        installed = await this.deps.install({
          runtime: prepared.runtime,
          staged: { runtime: prepared.staged, publish: this.#publishNoting(prepared, noted) },
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
      await this.#removeUnusedRuntimes(prepared, noted)
      const lingerWarning = installed.kind === "file" ? installed.lingerWarning : undefined
      return { ok: true, kind: installed.kind, target, configurationPath: installed.configurationPath, daemonRunning: true, ...(lingerWarning === undefined ? {} : { lingerWarning }) }
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
    const noted: NotedRuntimeCopy = {}
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
        updated = await this.deps.update({ runtime: prepared.runtime, staged: { runtime: prepared.staged, publish: this.#publishNoting(prepared, noted) } })
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
      await this.#removeUnusedRuntimes(prepared, noted)
      return { ok: true, kind: updated.kind, target, configurationPath: updated.configurationPath, daemonRunning: true }
    } finally {
      fence?.release()
      if (held) this.deps.daemon.endHandoff()
      this.#busy = false
    }
  }

  // #635: the staged publish, with the read of the copy the service runs
  // first. A read that fails leaves the previous copy unknown, and then no
  // cleanup runs; the publish itself goes ahead either way.
  #publishNoting(prepared: PreparedDaemonRuntime, noted: NotedRuntimeCopy): () => Promise<void> {
    return async () => {
      try {
        noted.previous = await this.deps.runtimeCopy()
      } catch {
        delete noted.previous
      }
      await prepared.publish()
      noted.published = true
    }
  }

  // #635: runs once the new service is confirmed, and only when this change
  // published a copy and knows what the service ran before. Nothing about it
  // is shown: a failure keeps the copies and leaves the outcome as it is.
  async #removeUnusedRuntimes(prepared: PreparedDaemonRuntime, noted: NotedRuntimeCopy): Promise<void> {
    if (noted.published !== true || noted.previous === undefined) return
    try {
      await this.deps.removeUnusedRuntimes({ published: prepared.runtime, previous: noted.previous })
    } catch {
      // Kept: the next confirmed change tries again.
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
