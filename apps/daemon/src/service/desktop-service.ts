import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { posix, win32 } from "node:path"

import { loginServiceHomePaths, loginServiceTaskName } from "@getdomovoi/protocol"

import type { DaemonEnvironment } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration } from "./configuration.js"
import type { ServiceConfiguration } from "./configuration.js"
import {
  installService,
  nodeServiceEffects,
  removeService,
  servicePlan,
  serviceStatus,
  updateService,
  type ServiceEffects,
  type ServiceStatus,
} from "./install.js"
import { DaemonServiceUpdateError, runServiceUpdate, trackInFlight } from "./update-outcome.js"
import { prepareWslUpdate } from "./wsl-install.js"

export { DaemonServiceUpdateError, type DaemonServiceUpdateOutcome } from "./update-outcome.js"

// The desktop's way to keep the daemon running after the app quits: a per-user
// service (a launchd agent, a systemd user unit or a Windows logon task) that
// runs the Node and the daemon the app ships. The CLI reaches the same
// installer through `domovoid service`; this is the programmatic half, with
// the runtime named by the caller rather than taken from the running process.

export type DaemonServiceRuntime = {
  // Absolute path to the Node executable the app ships.
  nodePath: string
  // Absolute path to the daemon entry the app ships (dist/index.js).
  daemonEntryPath: string
}

export type DaemonServiceOptions = {
  runtime: DaemonServiceRuntime
  // The settings the service keeps (profile, host, port, TLS paths), read as
  // the daemon reads its environment. Absent means the default profile under
  // the user's home. DOMOVOI_AUTH_TOKEN is refused, as the CLI refuses it.
  environment?: DaemonEnvironment
  // The handoff, ruled 2026-09-23: called once the runtime, the platform and
  // the configuration have been checked, and before the profile is claimed.
  // The desktop stops its in-app daemon here, so a refused install never
  // stops it. A rejection stops the install with nothing claimed or written.
  // The desktop refuses the handoff before calling this while a turn runs or
  // a gate waits; the installer does not look.
  releaseInAppDaemon?: () => Promise<void>
}

export type DaemonServiceInstallResult =
  | { kind: "file"; path: string; configurationPath: string }
  | { kind: "task"; name: string; configurationPath: string }

export type DaemonServiceRemovalResult =
  | { kind: "file"; path: string; profileRecovery: ProfileRecovery; profileRecoveryDetail?: string }
  | { kind: "task"; name: string; profileRecovery: ProfileRecovery; profileRecoveryDetail?: string }

type ProfileRecovery = "recorded" | "operator-confirmation-required" | "proof-unavailable" | "not-needed"

export type DaemonServiceStatus = ServiceStatus

export type RuntimeFileState = "file" | "missing" | "not-file"

// Facts about the user the service is installed for, and how a runtime path is
// checked. Defaults come from this process; tests replace them.
export type DaemonServiceDependencies = {
  platform: string
  home: string
  uid?: number
  user?: string
  runtimeFile: (path: string, part: "node" | "daemon") => Promise<RuntimeFileState>
  // How long an update waits for a stopped service's daemon to let the
  // profile go. Defaults to 10 seconds.
  profileReleaseWaitMs?: number
  // How long an update waits for a started service to report ready.
  // Defaults to 20 seconds.
  readinessWaitMs?: number
  // The budget of an update's swap, and separately of its restore. Defaults
  // to 60 seconds each.
  updateBudgetMs?: number
}

const taskName = "Domovoi daemon"

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

async function checkRuntime(runtime: DaemonServiceRuntime, dependencies: DaemonServiceDependencies, operation: "install" | "update" = "install"): Promise<void> {
  const paths = dependencies.platform === "win32" ? win32 : posix
  for (const [part, path] of [["node", runtime.nodePath], ["daemon", runtime.daemonEntryPath]] as const) {
    if (!paths.isAbsolute(path)) throw new DaemonServiceRuntimeMissingError(part, path, "relative", operation)
    const state = await dependencies.runtimeFile(path, part)
    if (state !== "file") throw new DaemonServiceRuntimeMissingError(part, path, state, operation)
  }
}

function target(dependencies: DaemonServiceDependencies) {
  return {
    platform: dependencies.platform,
    home: dependencies.home,
    ...(dependencies.uid === undefined ? {} : { uid: dependencies.uid }),
    ...(dependencies.user === undefined ? {} : { user: dependencies.user }),
  }
}

export async function installDaemonService(
  options: DaemonServiceOptions,
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceInstallResult> {
  await checkRuntime(options.runtime, dependencies)
  const configuration = createServiceConfiguration(options.environment ?? {}, {
    platform: dependencies.platform,
    homeDirectory: dependencies.home,
    workingDirectory: dependencies.home,
  })
  const serviceTarget = {
    ...target(dependencies),
    execPath: options.runtime.daemonEntryPath,
    runtime: options.runtime.nodePath,
    configuration,
  }
  // The plan is pure: building it refuses an unsupported platform, a missing
  // user or uid, and an overlong Windows command, all before the handoff.
  servicePlan(serviceTarget)
  await options.releaseInAppDaemon?.()
  const plan = await installService(serviceTarget, dependencies)
  return plan.kind === "file"
    ? { kind: "file", path: plan.path, configurationPath: plan.configuration.path }
    : { kind: "task", name: taskName, configurationPath: plan.configuration.path }
}

export type DaemonServiceUpdateOptions = {
  runtime: DaemonServiceRuntime
}

// Ruled 2026-09-23: "Update the service" moves the installed service to the
// runtime the app now ships, in place, on each platform. The runtime is
// checked first and nothing is changed before that passes. The saved service
// configuration (profile, host, port, TLS) is kept; for a WSL guest service
// it records the guest runtime, so that one field changes. If the swap fails,
// the previous service is put back and started, and the error says so.
export async function updateDaemonService(
  options: DaemonServiceUpdateOptions,
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceInstallResult> {
  await checkRuntime(options.runtime, dependencies, "update")
  let saved: ServiceConfiguration | undefined
  try {
    saved = dependencies.readConfiguration?.(dependencies.home, dependencies.platform)
  } catch (cause) {
    throw new DaemonServiceUpdateError("nothing-changed", cause)
  }
  if (!saved) throw new DaemonServiceUpdateError("not-installed")
  const waits = {
    profileWaitMs: dependencies.profileReleaseWaitMs ?? 10_000,
    readinessWaitMs: dependencies.readinessWaitMs ?? 20_000,
    budgetMs: dependencies.updateBudgetMs ?? 60_000,
  }
  if (dependencies.platform === "linux" && saved.wsl) {
    const tracked = trackInFlight(dependencies)
    const updated = await runServiceUpdate(dependencies.claimServiceOperation, waits.budgetMs, prepareWslUpdate(saved, options.runtime, tracked.effects, waits), tracked.inFlight)
    return { kind: "task", ...updated }
  }
  const plan = await updateService({
    ...target(dependencies),
    execPath: options.runtime.daemonEntryPath,
    runtime: options.runtime.nodePath,
    configuration: saved,
  }, dependencies, waits)
  return plan.kind === "file"
    ? { kind: "file", path: plan.path, configurationPath: plan.configuration.path }
    : { kind: "task", name: taskName, configurationPath: plan.configuration.path }
}

export function readDaemonServiceStatus(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceStatus> {
  return serviceStatus(target(dependencies), dependencies)
}

export async function removeDaemonService(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceRemovalResult> {
  const removed = await removeService(target(dependencies), dependencies)
  const recovery = {
    profileRecovery: removed.profileRecovery,
    ...(removed.profileRecoveryDetail === undefined ? {} : { profileRecoveryDetail: removed.profileRecoveryDetail }),
  }
  return removed.kind === "file"
    ? { kind: "file", path: removed.path, ...recovery }
    : { kind: "task", name: taskName, ...recovery }
}

export function nodeDaemonServiceDependencies(): DaemonServiceDependencies & ServiceEffects {
  const { uid, username } = userInfo()
  return {
    ...nodeServiceEffects(),
    platform: process.platform,
    home: homedir(),
    ...(uid >= 0 ? { uid } : {}),
    user: username,
    runtimeFile: async (path, part) => {
      try {
        if (!(await stat(path)).isFile()) return "not-file"
        // The service manager executes Node and Node reads the entry.
        if (process.platform !== "win32") await access(path, part === "node" ? constants.X_OK : constants.R_OK)
        return "file"
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
        return "not-file"
      }
    },
  }
}

// Ruled 2026-09-23 (#577, A): which runtime the login service runs, read from
// the service's own definition. The desktop stages its runtime at
// <profile>/runtime/<version>/ and the definition names that path, so the
// version is the folder name. A service that runs any other runtime (the CLI's
// own Node, a hand-edited unit) reads as installed with no version. Nothing is
// written; on Windows the task is only queried.
export type DaemonServiceRuntimeReport = { installed: false } | { installed: true; version?: string }

export type DaemonServiceRuntimeReader = {
  platform: string
  home: string
  readDefinition: (path: string) => Promise<string | undefined>
  capture: ServiceEffects["capture"]
}

const stagedRuntime = /[\\/]\.domovoi[\\/]runtime[\\/](\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)[\\/]/u

export function stagedRuntimeVersion(definition: string): string | undefined {
  return stagedRuntime.exec(definition)?.[1]
}

export async function readDaemonServiceRuntimeVersion(
  reader: DaemonServiceRuntimeReader = nodeDaemonServiceRuntimeReader(),
): Promise<DaemonServiceRuntimeReport> {
  let definition: string | undefined
  if (reader.platform === "win32") {
    const deadline = OperationDeadline.start(10_000)
    try {
      const queried = await reader.capture("schtasks", ["/query", "/tn", loginServiceTaskName, "/xml"], deadline)
      definition = queried.code === 0 ? queried.stdout : undefined
    } finally {
      deadline.clear()
    }
  } else if (reader.platform === "darwin" || reader.platform === "linux") {
    definition = await reader.readDefinition(posix.join(reader.home, loginServiceHomePaths[reader.platform]))
  }
  if (definition === undefined) return { installed: false }
  const version = stagedRuntimeVersion(definition)
  return version === undefined ? { installed: true } : { installed: true, version }
}

export function nodeDaemonServiceRuntimeReader(): DaemonServiceRuntimeReader {
  return {
    platform: process.platform,
    home: homedir(),
    readDefinition: async (path) => {
      try {
        return await readFile(path, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    capture: nodeServiceEffects().capture,
  }
}
