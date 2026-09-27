import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { posix, win32 } from "node:path"

import { isLoginServiceRuntimeVersion, loginServiceHomePaths, loginServiceTaskName } from "@getdomovoi/protocol"

import type { DaemonEnvironment } from "../config.js"
import { profileDirectory, profileLocation } from "../profile-directory.js"
import { OperationDeadline } from "../operation-deadline.js"
import { assertServiceProfile, callerProfile, createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import type { ServiceConfiguration } from "./configuration.js"
import {
  installService,
  isDomovoiTaskAction,
  isMissingServiceFailure,
  nodeServiceEffects,
  prepareServiceUpdate,
  removeService,
  servicePlan,
  serviceProgram,
  serviceStatus,
  type ServiceEffects,
  type ServiceStatus,
} from "./install.js"
import { launchdPlistProgram, systemdUnitProgram } from "./units.js"
import { withinServiceDeadline } from "./deadline.js"
import { DaemonServiceUpdateError, publishFirst, runServiceUpdate, trackInFlight } from "./update-outcome.js"
import { prepareWslUpdate } from "./wsl-install.js"

export { DaemonServiceUpdateError, type DaemonServiceUpdateOutcome } from "./update-outcome.js"

export {
  DaemonServiceHandoffError,
  LaunchdJobNotDomovoiError,
  SystemdPathCharacterError,
  WindowsTaskArgumentVariableError,
  WindowsTaskNotDomovoiError,
  WindowsTaskPathError,
  WindowsTaskPercentSignError,
} from "./install.js"

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
  // Given, it also names the caller's profile: a service saved for another
  // profile refuses the install under the service-operation lease, before the
  // handoff (security review round 2 of #577).
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
  // Security review round 4 of #577 (P2): the runtime staged but not yet in
  // place. Its files are checked first; publish moves it to `runtime` only
  // under the service-operation lease, after every profile check and before
  // the handoff, so a refused install changes no file.
  staged?: DaemonServiceStagedRuntime
}

// Security review round 7 of #577: publish puts the staged runtime into a
// fresh directory that nothing else uses (the desktop writes
// <profile>/runtime/<version>/<id>). It never moves or replaces an earlier
// copy, so a failure after it leaves the runtime the previous service runs
// as it was, and there is nothing to put back. A publish runs at most once,
// under the service-operation lease.
export type DaemonServiceStagedRuntime = {
  runtime: DaemonServiceRuntime
  publish: () => Promise<void>
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
  await checkRuntime(options.staged?.runtime ?? options.runtime, dependencies)
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
    ...(options.environment === undefined ? {} : { callerProfile: callerProfile(options.environment, dependencies.home, dependencies.platform) }),
    ...(options.staged === undefined ? {} : {
      beforeChanges: async () => {
        await options.staged!.publish()
        await checkRuntime(options.runtime, dependencies)
      },
    }),
  })
  return plan.kind === "file"
    ? { kind: "file", path: plan.path, configurationPath: plan.configuration.path }
    : { kind: "task", name: taskName, configurationPath: plan.configuration.path }
}

export type DaemonServiceUpdateOptions = {
  runtime: DaemonServiceRuntime
  // The caller's daemon environment. Given, the saved service must run the
  // profile it names, checked under the service-operation lease before any
  // manager action (security review round 2 of #577).
  environment?: DaemonEnvironment
  // Round 4 (P2): the staged runtime, published under the lease after the
  // profile check and before any manager action.
  staged?: DaemonServiceStagedRuntime
}

// Ruled 2026-09-23: "Update the service" moves the installed service to the
// runtime the app now ships, in place, on each platform. The runtime is
// checked first and nothing is changed before that passes. The saved service
// configuration (profile, host, port, TLS) is kept; the runtime it records
// (serviceRuntime, and a WSL guest's saved runtime) changes to the new one.
// If the swap fails, the previous service is put back and started, and the
// error says so. Ruled 2026-09-24 (A): only exactly the runtime service.json
// records is put back; an install without that record is refused.
export async function updateDaemonService(
  options: DaemonServiceUpdateOptions,
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceInstallResult> {
  await checkRuntime(options.staged?.runtime ?? options.runtime, dependencies, "update")
  const waits = {
    profileWaitMs: dependencies.profileReleaseWaitMs ?? 10_000,
    readinessWaitMs: dependencies.readinessWaitMs ?? 20_000,
    budgetMs: dependencies.updateBudgetMs ?? 60_000,
  }
  // Round 7 (P1): the publish is tracked with the manager calls, so the
  // service-operation lease is held until a publish the deadline gave up on
  // has settled.
  const tracked = trackInFlight({ ...dependencies, publishStaged: options.staged?.publish ?? (async () => {}) })
  return runServiceUpdate<DaemonServiceInstallResult>(dependencies.claimServiceOperation, waits.budgetMs, async (readDeadline) => {
    // Read under the service-operation lease: a removal that held it has
    // finished by now, and none can start before the update ends. A
    // configuration read before the claim could name a service that was
    // removed meanwhile, which a restore would then recreate and start.
    let saved: ServiceConfiguration | undefined
    try {
      saved = dependencies.readConfiguration?.(dependencies.home, dependencies.platform)
    } catch (cause) {
      throw new DaemonServiceUpdateError("nothing-changed", cause)
    }
    if (!saved) throw new DaemonServiceUpdateError("not-installed")
    if (options.environment !== undefined) {
      assertServiceProfile(profileLocation(saved.homeDirectory, saved.profileDirectory, dependencies.platform), callerProfile(options.environment, dependencies.home, dependencies.platform), dependencies.platform)
    }
    // Security review rounds 4 and 5 of #577: the staged runtime goes into
    // place only once every step that can refuse with nothing changed has
    // passed, right before the new definition is written (launchd, systemd),
    // or as the first step of the swap (WSL, whose refusals all come before).
    //
    // Round 8 (P2), ruled 2026-09-26 (Q64 A): on systemd and for a WSL guest
    // the publish is the first change, so a published runtime that fails its
    // check has changed nothing about the service. That is "runtime-copied",
    // naming the copy, not "nothing-changed". Round 10 (P2): there the publish
    // is not cut short by the deadline; publishFirst waits for it and answers
    // by what happened to the copy. launchd and the Windows task publish after
    // the previous service was stopped; there a failure is a failed swap, and
    // the previous service is put back.
    const firstChange = dependencies.platform === "linux"
    const copy = posix.dirname(posix.dirname(posix.dirname(options.runtime.daemonEntryPath)))
    const publish = async (deadline: OperationDeadline, first = firstChange) => {
      if (options.staged === undefined) return
      const check = () => checkRuntime(options.runtime, dependencies, "update")
      if (first) return publishFirst(deadline, () => tracked.effects.publishStaged(), check, copy)
      await tracked.effects.publishStaged()
      await check()
    }
    if (dependencies.platform === "linux" && saved.wsl) {
      const steps = await prepareWslUpdate(saved, options.runtime, tracked.effects, waits, tracked.inFlight)(readDeadline)
      // Round 11 (P2): an update that resumes an interrupted one may find no
      // task registered, so there the publish is not the first change and
      // "runtime-copied" would say a service is set to run the previous
      // runtime when none is. It runs under the
      // deadline, as launchd's does, and a failure is a failed swap: the
      // previous task is registered, started and must report ready.
      const publishStep = (deadline: OperationDeadline) => steps.resuming
        ? withinServiceDeadline(deadline, () => publish(deadline, false))
        : publish(deadline)
      return { ...steps, swap: async (deadline) => { await publishStep(deadline); return { kind: "task" as const, ...await steps.swap(deadline) } } }
    }
    const steps = await prepareServiceUpdate({
      ...target(dependencies),
      execPath: options.runtime.daemonEntryPath,
      runtime: options.runtime.nodePath,
      configuration: saved,
    }, tracked.effects, waits, tracked.inFlight, options.staged === undefined ? undefined : publish)(readDeadline)
    return {
      ...steps,
      swap: async (deadline): Promise<DaemonServiceInstallResult> => {
        const plan = await steps.swap(deadline)
        return plan.kind === "file"
          ? { kind: "file", path: plan.path, configurationPath: plan.configuration.path }
          : { kind: "task", name: taskName, configurationPath: plan.configuration.path }
      },
    }
  }, tracked.inFlight)
}

export function readDaemonServiceStatus(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
): Promise<DaemonServiceStatus> {
  return serviceStatus(target(dependencies), dependencies)
}

// options.environment: the caller's daemon environment. Given, the saved
// service must run the profile it names, checked under the service-operation
// lease before any manager action (security review round 2 of #577).
export async function removeDaemonService(
  dependencies: DaemonServiceDependencies & ServiceEffects = nodeDaemonServiceDependencies(),
  options: { environment?: DaemonEnvironment } = {},
): Promise<DaemonServiceRemovalResult> {
  const removed = await removeService(target(dependencies), dependencies, {
    ...(options.environment === undefined ? {} : { callerProfile: callerProfile(options.environment, dependencies.home, dependencies.platform) }),
  })
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
  // The saved service configuration, whose profile the version is bound to.
  readConfiguration: NonNullable<ServiceEffects["readConfiguration"]>
}

// Round 9 (P2): the one Exec action of a Windows task, as Task Scheduler
// reports it (schtasks /query /xml): exactly one Actions element holding
// exactly one Exec with a Command and Arguments, or undefined.
function taskAction(definition: string): { path: string; arguments: string } | undefined {
  if ((definition.match(/<Actions[\s>/]/gu) ?? []).length !== 1) return undefined
  const actions = /<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/u.exec(definition)?.[1]
  const exec = actions === undefined ? undefined : /^\s*<Exec>\s*<Command>([^<]*)<\/Command>\s*<Arguments>([^<]*)<\/Arguments>\s*<\/Exec>\s*$/u.exec(actions)
  if (exec === undefined || exec === null) return undefined
  const decode = (text: string) => text.replace(/&(?:quot|apos|lt|gt|amp);/gu, (entity) => ({ "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" })[entity] ?? entity)
  return { path: decode(exec[1] ?? ""), arguments: decode(exec[2] ?? "") }
}

// Security review round 4 of #577 (P3): the version is the one staged under
// the profile the saved configuration names. Round 7: each publish is a fresh
// directory, <profile>/runtime/<version>/<id>/node/bin/node (node\node.exe on
// Windows), with a 12-character hexadecimal id. Round 8: the version must pass
// the check the desktop publishes under (isLoginServiceRuntimeVersion, P3).
// Round 9 (P2): the definition must be exactly what an install writes for
// that copy: the whole launchd plist or systemd unit as its renderer gives it
// (launchdPlistProgram, systemdUnitProgram), so no Program key, later
// ExecStart line or other change can run something else; for a Windows task,
// one action whose Command and Arguments are the install's. Anything else,
// another profile's runtime included, has none.
const publishId = /^[0-9a-f]{12}$/u

export function stagedRuntimeVersion(platform: string, definition: string, profileDirectory: string, configurationPath: string): string | undefined {
  return stagedRuntimeCopy(platform, definition, profileDirectory, configurationPath)?.version
}

// The same reading, with the published copy's directory the definition runs:
// <profile>/runtime/<version>/<id>, built from the saved profile.
export function stagedRuntimeCopy(platform: string, definition: string, profileDirectory: string, configurationPath: string): { version: string; copy: string } | undefined {
  const paths = platform === "win32" ? win32 : posix
  const action = platform === "win32" ? taskAction(definition) : undefined
  const written = platform === "darwin" ? launchdPlistProgram(definition)
    : platform === "linux" ? systemdUnitProgram(definition)
      : action === undefined ? undefined : { execPath: /^"([^"]*)"$/u.exec(action.path)?.[1] ?? action.path, args: [] }
  if (written === undefined) return undefined
  const program = written.execPath
  const nodeDirectory = platform === "win32" ? paths.dirname(program) : paths.dirname(paths.dirname(program))
  const copy = paths.dirname(nodeDirectory)
  const id = paths.basename(copy)
  const version = paths.basename(paths.dirname(copy))
  if (!isLoginServiceRuntimeVersion(version) || !publishId.test(id)) return undefined
  const expectedCopy = paths.join(profileDirectory, "runtime", version, id)
  const node = platform === "win32" ? paths.join(expectedCopy, "node", "node.exe") : paths.join(expectedCopy, "node", "bin", "node")
  const entry = paths.join(expectedCopy, "daemon", "dist", "index.js")
  if (action !== undefined) return isDomovoiTaskAction(action, configurationPath, { executable: node, entry }) ? { version, copy: expectedCopy } : undefined
  const expected = serviceProgram(entry, node, configurationPath)
  const same = written.execPath === expected.program && written.args.length === expected.args.length
    && written.args.every((argument, index) => argument === expected.args[index])
  return same ? { version, copy: expectedCopy } : undefined
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
  let bound: { profile: string; configurationPath: string } | undefined
  try {
    const saved = reader.readConfiguration(reader.home, reader.platform)
    bound = saved === undefined ? undefined : {
      profile: profileDirectory(profileLocation(saved.homeDirectory, saved.profileDirectory), reader.platform),
      configurationPath: serviceConfigurationPath(saved.homeDirectory, reader.platform),
    }
  } catch {
    bound = undefined
  }
  const version = bound === undefined ? undefined : stagedRuntimeVersion(reader.platform, definition, bound.profile, bound.configurationPath)
  return version === undefined ? { installed: true } : { installed: true, version }
}

// #635: which published runtime copy the login service runs, for the removal
// of unused copies. Read by the same rules as the version above, but it never
// guesses: a definition, a Windows task query or a saved configuration that
// cannot be read throws, rather than read as no service or no copy. Only a
// definition that is not there, or a task Task Scheduler says does not exist,
// is not installed. Installed with no copy: the definition names none this
// app published, or none it can be sure of.
export type DaemonServiceRuntimeCopy = { installed: false } | { installed: true; copy?: string }

export async function readDaemonServiceRuntimeCopy(
  reader: DaemonServiceRuntimeReader = nodeDaemonServiceRuntimeReader(),
): Promise<DaemonServiceRuntimeCopy> {
  let definition: string | undefined
  if (reader.platform === "win32") {
    const deadline = OperationDeadline.start(10_000)
    try {
      const queried = await reader.capture("schtasks", ["/query", "/tn", loginServiceTaskName, "/xml"], deadline)
      if (queried.code === 0) definition = queried.stdout
      else if (!isMissingServiceFailure("win32", queried)) throw new Error(`schtasks could not read the login service: ${queried.stderr?.trim() || `exit code ${queried.code}`}`)
    } finally {
      deadline.clear()
    }
  } else if (reader.platform === "darwin" || reader.platform === "linux") {
    definition = await reader.readDefinition(posix.join(reader.home, loginServiceHomePaths[reader.platform]))
  } else {
    throw new Error(`${reader.platform} has no login service this can read`)
  }
  if (definition === undefined) return { installed: false }
  const saved = reader.readConfiguration(reader.home, reader.platform)
  if (saved === undefined) return { installed: true }
  const profile = profileDirectory(profileLocation(saved.homeDirectory, saved.profileDirectory), reader.platform)
  const staged = stagedRuntimeCopy(reader.platform, definition, profile, serviceConfigurationPath(saved.homeDirectory, reader.platform))
  return staged === undefined ? { installed: true } : { installed: true, copy: staged.copy }
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
    readConfiguration: nodeServiceEffects().readConfiguration!,
  }
}
