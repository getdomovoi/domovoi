import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { posix, win32 } from "node:path"

import type { DaemonEnvironment } from "../config.js"
import { createServiceConfiguration } from "./configuration.js"
import {
  installService,
  nodeServiceEffects,
  removeService,
  servicePlan,
  serviceStatus,
  type ServiceEffects,
  type ServiceStatus,
} from "./install.js"

export { WindowsTaskNotDomovoiError, WindowsTaskPercentSignError } from "./install.js"

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
  // the configuration have been checked, the service-operation lease is held
  // and the saved registration has been read, and before the profile is
  // claimed.
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
}

const taskName = "Domovoi daemon"

export class DaemonServiceRuntimeMissingError extends Error {
  constructor(readonly part: "node" | "daemon", readonly path: string, reason: "missing" | "not-file" | "relative") {
    const what = part === "node" ? "The Node runtime this app ships" : "The Domovoi daemon this app ships"
    const why = reason === "relative"
      ? `is named by a relative path, ${path}`
      : reason === "not-file" ? `is not a runnable file at ${path}` : `was not found at ${path}`
    super(`${what} ${why}. No service was installed and no service files were changed.`)
    this.name = "DaemonServiceRuntimeMissingError"
  }
}

async function checkRuntime(runtime: DaemonServiceRuntime, dependencies: DaemonServiceDependencies): Promise<void> {
  const paths = dependencies.platform === "win32" ? win32 : posix
  for (const [part, path] of [["node", runtime.nodePath], ["daemon", runtime.daemonEntryPath]] as const) {
    if (!paths.isAbsolute(path)) throw new DaemonServiceRuntimeMissingError(part, path, "relative")
    const state = await dependencies.runtimeFile(path, part)
    if (state !== "file") throw new DaemonServiceRuntimeMissingError(part, path, state)
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
  // user or uid, an overlong Windows command and a Windows path Task
  // Scheduler would expand, all before the service-operation lease is taken.
  servicePlan(serviceTarget)
  // Security review round 1: the installer calls the handoff inside that
  // lease, so a busy lease refuses with the in-app daemon still running.
  const plan = await installService(serviceTarget, dependencies, {
    ...(options.releaseInAppDaemon === undefined ? {} : { handoff: options.releaseInAppDaemon }),
  })
  return plan.kind === "file"
    ? { kind: "file", path: plan.path, configurationPath: plan.configuration.path }
    : { kind: "task", name: taskName, configurationPath: plan.configuration.path }
}

export function readDaemonServiceStatus(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceStatus> {
  // Security review round 1: a Windows task under Domovoi's name is reported
  // only once service.json and the task's action show Domovoi registered it.
  return serviceStatus(target(dependencies), dependencies, { verifyWindowsTaskOwner: true })
}

export async function removeDaemonService(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceRemovalResult> {
  // Security review round 1: a Windows task Domovoi did not register is
  // neither stopped nor deleted.
  const removed = await removeService(target(dependencies), dependencies, { verifyWindowsTaskOwner: true })
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
