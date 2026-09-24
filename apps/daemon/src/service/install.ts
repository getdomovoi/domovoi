import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, posix } from "node:path"
import { userInfo } from "node:os"
import { installedWslTask } from "./wsl-registration.js"
import { runWslServiceCommand } from "./wsl-install.js"
import { stopGuestSupervisor } from "./supervisor-command.js"

import type { DaemonEnvironment } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { claimProfile, type ProfileLease } from "../profile-lease.js"
import { localOwnerRemovalReceiptPath, writeLocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { readServiceRemovalSnapshot, serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration } from "./configuration.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { withinServiceDeadline } from "./deadline.js"
import { claimServiceOperation } from "./operation-lease.js"
import { launchdPlist, systemdUnit } from "./units.js"
import { readWindowsTaskAction, readWindowsTaskState, removeWindowsTask, stopWindowsTask, WindowsTaskRemovalError, windowsTaskRemovalPlan, type WindowsTaskRemovalPlan } from "./windows-task.js"
import { claimProfileAfterStop, currentInstance, DaemonServiceUpdateError, OwnerInstances, releaseWhenSettled, within, type InFlight, type ServiceSwap } from "./update-outcome.js"
import { readLocalOwnerRecord, type LocalOwnerRecord } from "../local-owner-record.js"
import { readGuestSupervisorStatus } from "./supervisor-command.js"
import { profileLocation, sameProfileDirectory, type ProfileLocation } from "../profile-directory.js"

const serviceName = "domovoid"
const unitFile = `${serviceName}.service`
const agentFile = "sh.domovoi.domovoid.plist"
const agentLabel = "sh.domovoi.domovoid"
const displayName = "Domovoi daemon"

export type ServiceCommand = { command: string; args: string[] }

type ServiceRegistrationPlan =
  | { kind: "file"; path: string; contents: string; commands: ServiceCommand[] }
  | { kind: "task"; commands: ServiceCommand[] }

export type ServicePlan = ServiceRegistrationPlan & {
  configuration: { path: string; contents: string }
}

type ServiceRemovalPlan = Extract<ServiceRegistrationPlan, { kind: "file" }> | WindowsTaskRemovalPlan

export type ServiceTarget = {
  platform: string
  execPath: string
  // The Windows task runs a command line, not a file: handing it a .js path
  // lets the shell pick an interpreter, and on Windows that is the Script Host
  // rather than Node. The runtime is named so the task launches what we mean.
  runtime?: string
  home?: string
  uid?: number
  user?: string
  configuration: ServiceConfiguration
}

export type CapturedRun = { code: number; stdout: string; stderr?: string }

export type ServiceEffects = {
  readConfiguration?: (home: string, platform: string) => ServiceConfiguration | undefined
  stopSupervisor?: (path: string, deadline: OperationDeadline) => Promise<unknown>
  claimServiceOperation: () => ReturnType<typeof claimServiceOperation>
  claimProfile: (homeDirectory: ProfileLocation) => ProfileLease
  registeredProfile?: (home: string, platform: string) => ProfileLocation | undefined
  removalSnapshot: typeof readServiceRemovalSnapshot
  writeRemovalReceipt: typeof writeLocalOwnerRemovalReceipt
  write: (path: string, contents: string, deadline: OperationDeadline) => Promise<void>
  // Reads a service file back, so an update can restore it.
  read?: (path: string, deadline: OperationDeadline) => Promise<string>
  // The daemon's local owner record: which instance holds the profile, and
  // whether it reports ready.
  readOwner?: (profile: ProfileLocation) => LocalOwnerRecord | undefined
  run: (command: string, args: string[], deadline: OperationDeadline) => Promise<void>
  capture: (command: string, args: string[], deadline: OperationDeadline) => Promise<CapturedRun>
  exists: (path: string, deadline: OperationDeadline) => Promise<boolean>
  remove: (path: string, deadline: OperationDeadline) => Promise<void>
  supervisorStatus?: (home: string) => Promise<ServiceStatus | undefined>
}

export type ServiceStatus = {
  installed: boolean | null
  running: boolean
  detail: string
  supervisionFailure?: "exhausted" | "observation-failure" | "configuration-missing"
}

// A quote or a control character would let a value break out of the file or
// command it is written into. Checked by code point because a regular
// expression that contains a control character is itself hard to review.
function hasForbiddenCharacter(value: string): boolean {
  return value.includes("\"") || [...value].some((character) => character < " ")
}

function failureText(error: unknown): string {
  const failure = error as { message?: unknown; stderr?: unknown; stdout?: unknown } | null
  return [failure?.message, failure?.stderr, failure?.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join("\n")
}

function isMissingServiceFailure(platform: string, error: unknown): boolean {
  const detail = failureText(error)
  if (platform === "linux") {
    return /^Unit not loaded$/i.test(detail)
      || /unit(?: file)?\s+domovoid\.service.*(?:not loaded|not found|does not exist|could not be found)/i.test(detail)
  }
  if (platform === "darwin") {
    return /(?:could not find|no such) service.*sh\.domovoi\.domovoid/i.test(detail)
  }
  if (platform === "win32") {
    return /(?:cannot find the (?:file|task) specified|task.*does not exist)/i.test(detail)
  }
  return false
}

function captureFailure(command: string, result: CapturedRun): Error {
  const detail = result.stderr?.trim()
  return new Error(detail || `${command} exited with code ${result.code}`)
}

function assertHome(home: string | undefined): string {
  if (typeof home !== "string" || home === "") {
    throw new Error("the install needs a home directory to put the service file in")
  }
  return home
}

function assertUser(user: string | undefined): string {
  if (typeof user !== "string" || user === "" || hasForbiddenCharacter(user)) {
    throw new Error("the logon task needs the user it runs as")
  }
  return user
}

function assertExecutable(execPath: string, description = "domovoid"): string {
  if (!/^[A-Za-z]:\\/.test(execPath) || hasForbiddenCharacter(execPath)) {
    throw new Error(`${execPath} is not an absolute path to ${description}`)
  }
  return execPath
}

function assertUid(uid: number | undefined): number {
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
    throw new Error("launchd needs the user the agent is installed for")
  }
  return uid
}

function unitPath(home: string | undefined): string {
  return posix.join(assertHome(home), ".config", "systemd", "user", unitFile)
}

function agentPath(home: string | undefined): string {
  return posix.join(assertHome(home), "Library", "LaunchAgents", agentFile)
}

// A service is installed for the user who asked for it: a systemd user unit, a
// launchd agent in that user's own LaunchAgents, or a Windows logon task.
// Nothing here writes to a system-wide location or asks for elevation.
function windowsTaskCommand(execPath: string, runtime: string | undefined): string {
  const target = assertExecutable(execPath)
  if (!/\.[cm]?js$/i.test(target)) return `"${target}"`
  if (runtime === undefined) {
    throw new Error("a Windows task that runs a script needs the Node executable that runs it")
  }
  return `"${assertExecutable(runtime)}" "${target}"`
}

export function servicePlan({
  platform,
  execPath,
  home,
  uid,
  user,
  runtime,
  configuration,
}: ServiceTarget): ServicePlan {
  const configurationFile = {
    path: serviceConfigurationPath(configuration.homeDirectory, platform),
    contents: serializeServiceConfiguration(configuration),
  }
  // The configured home owns the per-user registration. The daemon profile
  // is explicit saved configuration, not a replacement provider HOME.
  if (home !== configuration.homeDirectory) throw new Error("The service configuration must belong to the installing user home")
  if (configuration.wsl) {
    if (platform !== "linux" || !configuration.registrationId) throw new Error("WSL service requires a guest registration")
    const task = installedWslTask(configuration.wsl, configuration.registrationId, configurationFile.path)
    return { kind: "task", configuration: configurationFile, commands: [task.register, task.start] }
  }
  const serviceArgs = ["--service-config", configurationFile.path]
  const program = runtime === undefined ? execPath : runtime
  const args = runtime === undefined ? serviceArgs : [execPath, ...serviceArgs]
  if (platform === "linux") {
    return {
      configuration: configurationFile,
      kind: "file",
      path: unitPath(home),
      contents: systemdUnit({ execPath: program, args }),
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", unitFile] },
      ],
    }
  }

  if (platform === "darwin") {
    const path = agentPath(home)
    return {
      configuration: configurationFile,
      kind: "file",
      path,
      contents: launchdPlist({ execPath: program, args }),
      commands: [{ command: "launchctl", args: ["bootstrap", `gui/${assertUid(uid)}`, path] }],
    }
  }

  if (platform === "win32") {
    const taskCommand = `${windowsTaskCommand(execPath, runtime)} --service-config "${assertExecutable(configurationFile.path, "the service configuration")}"`
    if (taskCommand.length > 262) {
      throw new Error("Windows task command exceeds 262 characters. Install Node and Domovoi at shorter absolute paths before installing the service. No service files were changed.")
    }
    // A Windows service created with sc.exe runs as LocalSystem and belongs to
    // the machine, which is neither what the systemd user unit nor the launchd
    // agent does. A logon task runs as the user who asked, with their own
    // privileges, and needs no elevation to install.
    return {
      configuration: configurationFile,
      kind: "task",
      commands: [
        {
          command: "schtasks",
          args: [
            "/create",
            "/tn",
            displayName,
            "/tr",
            taskCommand,
            "/sc",
            "onlogon",
            "/ru",
            assertUser(user),
            "/rl",
            "LIMITED",
            "/f",
          ],
        },
        { command: "schtasks", args: ["/run", "/tn", displayName] },
      ],
    }
  }

  throw new Error(`${platform} has no service manager this knows how to install into`)
}

// Removal stops the service before the file it points at is deleted, so a
// service manager is never left loading a unit that is not there.
export function serviceRemovalPlan({
  platform,
  home,
  uid,
}: Pick<ServiceTarget, "platform" | "home" | "uid">): ServiceRemovalPlan {
  if (platform === "linux") {
    return {
      kind: "file",
      path: unitPath(home),
      contents: "",
      commands: [
        { command: "systemctl", args: ["--user", "disable", "--now", unitFile] },
        { command: "systemctl", args: ["--user", "daemon-reload"] },
      ],
    }
  }

  if (platform === "darwin") {
    return {
      kind: "file",
      path: agentPath(home),
      contents: "",
      commands: [{ command: "launchctl", args: ["bootout", `gui/${assertUid(uid)}/${agentLabel}`] }],
    }
  }

  if (platform === "win32") {
    return windowsTaskRemovalPlan(displayName)
  }

  throw new Error(`${platform} has no service manager this knows how to remove from`)
}

async function writeUnit(path: string, contents: string, deadline: OperationDeadline): Promise<void> {
  const directory = dirname(path)
  await withinServiceDeadline(deadline, () => mkdir(directory, { recursive: true, mode: 0o700 }))
  if (process.platform !== "win32") await withinServiceDeadline(deadline, () => chmod(directory, 0o700))
  const staging = `${path}.${randomUUID()}.tmp`
  try {
    // Never truncate the last complete configuration. Exclusive creation gives
    // this install a private inode, including when the old file was writable.
    // The write and the rename are awaited to their end rather than raced
    // against the deadline, so this settles only once the file is known to be
    // published or not; a caller that ran out of time (withinServiceDeadline)
    // can wait for it before restoring. The write honours the abort signal,
    // and no rename starts after the deadline.
    deadline.throwIfExpired()
    await writeFile(staging, contents, { flag: "wx", mode: 0o600, signal: deadline.signal })
    deadline.throwIfExpired()
    await rename(staging, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error
    try {
      // Cleanup shares the install budget. If it expired, no new I/O begins;
      // the private staging file may remain, but never becomes launch input.
      await withinServiceDeadline(deadline, () => rm(staging, { force: true }))
    } catch {
      throw new Error(`Service file publication failed at ${path}; a temporary file may remain at ${staging}`, { cause: error })
    }
    throw error
  }
}

async function serviceOperation<T>(effects: Pick<ServiceEffects, "claimServiceOperation">, operation: (deadline: OperationDeadline) => Promise<T>): Promise<T> {
  const deadline = OperationDeadline.start(30_000)
  let lease: ReturnType<typeof claimServiceOperation> | undefined
  try {
    deadline.throwIfExpired()
    lease = effects.claimServiceOperation()
    return await withinServiceDeadline(deadline, () => operation(deadline))
  } finally {
    // An expired OS call can still settle. Keep exclusion until this CLI exits,
    // matching the profile lease rule, rather than exposing a second writer.
    // Process exit does not prove a previously submitted native job stopped.
    try {
      // Rejections bypass the successful-settlement clock check. An overdue
      // timer callback must not make a late error release exclusion early.
      deadline.remainingMs()
      if (!deadline.signal.aborted) lease?.release()
    } finally { deadline.clear() }
  }
}

// The file is written before the service manager is asked to load it, and a
// write that fails stops the install rather than asking the manager to launch
// with a unit or configuration that is not there.
async function installWithDeadline(
  target: ServiceTarget,
  effects: Pick<ServiceEffects, "write" | "run" | "claimProfile" | "remove" | "registeredProfile">,
  deadline: OperationDeadline,
): Promise<ServicePlan> {
  // Reinstalling is a new supervisor decision, not reuse of an old recovery
  // authorization. Assign the identity here, even if the caller supplied one.
  const plan = servicePlan({ ...target, configuration: { ...target.configuration, registrationId: randomUUID() } })
  deadline.throwIfExpired()
  const profile = profileLocation(target.configuration.homeDirectory, target.configuration.profileDirectory)
  const previous = effects.registeredProfile?.(target.configuration.homeDirectory, target.platform)
  const leases: ProfileLease[] = []
  try {
    if (previous && !sameProfileDirectory(previous, profile)) leases.push(effects.claimProfile(previous))
    leases.push(effects.claimProfile(profile))
    await withinServiceDeadline(deadline, () => effects.remove(localOwnerRemovalReceiptPath(profile), deadline))
    await withinServiceDeadline(deadline, () => effects.write(plan.configuration.path, plan.configuration.contents, deadline))
    if (plan.kind === "file") await withinServiceDeadline(deadline, () => effects.write(plan.path, plan.contents, deadline))
    deadline.throwIfExpired()
  } finally {
    // Timed-out filesystem work may still settle. Retain the lease until this
    // CLI process exits in that case. Otherwise the saved service config now
    // prevents Desktop fallback, so release before asking the manager to start.
    if (!deadline.signal.aborted) for (const lease of leases) lease.release()
  }
  for (const { command, args } of plan.commands) await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
  return plan
}

export function installService(target: ServiceTarget, effects: Pick<ServiceEffects, "write" | "run" | "claimProfile" | "remove" | "claimServiceOperation" | "registeredProfile">): Promise<ServicePlan> {
  return serviceOperation(effects, (deadline) => installWithDeadline(target, effects, deadline))
}

export type ServiceUpdateEffects = Pick<ServiceEffects, "write" | "read" | "run" | "capture" | "exists" | "claimProfile" | "claimServiceOperation" | "readOwner">

export type ServiceUpdateWaits = {
  // How long a stopped service's daemon has to let the profile go.
  profileWaitMs: number
  // How long a started service has to report ready.
  readinessWaitMs: number
  // The budget of the swap, and separately of the restore.
  budgetMs: number
}

// Ruled 2026-09-23: an update swaps the installed service to a new runtime in
// place. The saved service configuration is kept as it is; the service
// definition changes. What the service ran before is read first, so any
// failed step, a timeout included, puts it back. A start counts only once the
// daemon reports ready, after the swap and after a restore alike. The caller
// runs this under the service-operation lease (runServiceUpdate), with effects
// tracked by trackInFlight.
export function prepareServiceUpdate(target: ServiceTarget, effects: ServiceUpdateEffects, waits: ServiceUpdateWaits, inFlight: InFlight) {
  return async (readDeadline: OperationDeadline): Promise<ServiceSwap<ServicePlan>> => {
    const plan = servicePlan(target)
    const profile = profileLocation(target.configuration.homeDirectory, target.configuration.profileDirectory)
    const registrationId = target.configuration.registrationId
    const readOwner = effects.readOwner
    if (!readOwner) throw new Error("the update needs to read the daemon's owner record")
    const runIn = (deadline: OperationDeadline) => (command: ServiceCommand) => withinServiceDeadline(deadline, () => effects.run(command.command, command.args, deadline))
    const writeIn = (deadline: OperationDeadline) => (path: string, contents: string) => withinServiceDeadline(deadline, () => effects.write(path, contents, deadline))
    // Every instance seen, from the one running now on; none of them can
    // count as a new start.
    const instances = new OwnerInstances(readOwner, profile)
    await instances.note(readDeadline)
    // Starts a service definition and waits for its daemon to report ready.
    const startIn = (deadline: OperationDeadline) => async (commands: readonly ServiceCommand[]) => {
      await instances.note(deadline)
      for (const command of commands) await runIn(deadline)(command)
      await instances.waitUntilReady(registrationId, waits.readinessWaitMs, deadline)
    }
    // Holds the profile once the stopped daemon lets it go, for the step given
    // and until every call it started has settled.
    const whileHeldIn = (deadline: OperationDeadline, stoppedInstance: string | undefined) => async (step: () => Promise<void>) => {
      const lease = await claimProfileAfterStop(effects.claimProfile, readOwner, profile, stoppedInstance, waits.profileWaitMs, deadline)
      try {
        await step()
      } finally {
        await releaseWhenSettled(lease, inFlight)
      }
    }

    if (plan.kind === "file") {
      if (!await withinServiceDeadline(readDeadline, () => effects.exists(plan.path, readDeadline))) throw new DaemonServiceUpdateError("not-installed")
      if (!effects.read) throw new Error("the update needs to read the installed service file")
      const read = effects.read
      const previous = await withinServiceDeadline(readDeadline, () => read(plan.path, readDeadline))

      if (target.platform === "linux") {
        // The running daemon holds the profile across its own restart, so the
        // profile is not claimed here.
        const reload = { command: "systemctl", args: ["--user", "daemon-reload"] }
        const restart = { command: "systemctl", args: ["--user", "restart", unitFile] }
        return {
          swap: async (deadline) => {
            try {
              await writeIn(deadline)(plan.path, plan.contents)
            } catch (cause) {
              // The unit is replaced by rename, so a write that failed on its
              // own left the old one. A write the deadline cut short may still
              // rename the new unit into place: that is a failed swap, and the
              // restore runs once the write has settled.
              if (deadline.signal.aborted) throw cause
              throw new DaemonServiceUpdateError("nothing-changed", cause)
            }
            await runIn(deadline)(reload)
            await startIn(deadline)([restart])
            return plan
          },
          restore: async (deadline) => {
            await writeIn(deadline)(plan.path, previous)
            await runIn(deadline)(reload)
            await startIn(deadline)([restart])
          },
        }
      }

      // launchd: the agent is booted out, so its daemon lets the profile go.
      // The profile is held while the new agent is written, then released
      // before the new agent starts and claims it.
      const domain = `gui/${assertUid(target.uid)}`
      const job = `${domain}/${agentLabel}`
      const bootout = { command: "launchctl", args: ["bootout", job] }
      const bootstrap = { command: "launchctl", args: ["bootstrap", domain, plan.path] }
      const stoppedInstance = currentInstance(readOwner, profile)
      const loaded = async (deadline: OperationDeadline) => {
        const printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", job], deadline))
        if (printed.code === 0) return true
        if (printed.code === 113 && isMissingServiceFailure("darwin", printed)) return false
        throw captureFailure("launchctl", printed)
      }
      const bootoutIn = (deadline: OperationDeadline) => async () => {
        try {
          await runIn(deadline)(bootout)
        } catch (cause) {
          if (isMissingServiceFailure("darwin", cause)) return
          // The refusal may still stop the agent, and a job listed right after
          // it can unload a moment later, so it is watched for a while.
          // Still loaded then, it stopped nothing; unloaded, it stopped the
          // previous service, which is put back.
          const unloaded = await within(waits.profileWaitMs, deadline, async () => !await loaded(deadline))
          if (!unloaded) throw new DaemonServiceUpdateError("nothing-changed", cause)
          throw cause
        }
      }
      let wroteNew = false
      return {
        swap: async (deadline) => {
          await bootoutIn(deadline)()
          await whileHeldIn(deadline, stoppedInstance)(async () => {
            wroteNew = true
            await writeIn(deadline)(plan.path, plan.contents)
          })
          await startIn(deadline)([bootstrap])
          return plan
        },
        restore: async (deadline) => {
          if (await loaded(deadline)) await runIn(deadline)(bootout)
          if (wroteNew) await writeIn(deadline)(plan.path, previous)
          await startIn(deadline)([bootstrap])
        },
      }
    }

    // The Windows logon task: stopped (and disabled) through Task Scheduler,
    // the profile held while it lets go, then registered again with the new
    // command, which enables it, and run.
    const previous = await readWindowsTaskAction(displayName, effects, readDeadline)
    if (previous === "missing") throw new DaemonServiceUpdateError("not-installed")
    const restoreCommands = plan.commands.map((command) => command.args[0] !== "/create" ? command : {
      ...command,
      args: command.args.map((arg, index) => command.args[index - 1] === "/tr" ? `"${previous.path}" ${previous.arguments}` : arg),
    })
    const stoppedInstance = currentInstance(readOwner, profile)
    return {
      swap: async (deadline) => {
        try {
          await stopWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline)
        } catch (cause) {
          // A refused stop may have changed nothing: the task still enabled,
          // running the command it ran before. Then the service was left as
          // it was, and there is nothing to put back.
          const now = await readWindowsTaskAction(displayName, effects, deadline).catch(() => undefined)
          if (now !== undefined && now !== "missing" && now.enabled && now.state === 4
            && now.path === previous.path && now.arguments === previous.arguments) {
            throw new DaemonServiceUpdateError("nothing-changed", cause)
          }
          throw cause
        }
        await whileHeldIn(deadline, stoppedInstance)(async () => {})
        await startIn(deadline)(plan.commands)
        return plan
      },
      restore: async (deadline) => {
        // Whatever instance the swap left running is stopped first: Task
        // Scheduler ignores a run while one runs, and a late start of the new
        // runtime must not pass for the previous service.
        await stopWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline)
        await startIn(deadline)(restoreCommands)
      },
    }
  }
}

// A service that was never installed is not an error to remove: the end state
// the caller asked for is the one they get either way.
type RemovalEffects = Pick<ServiceEffects, "run" | "capture" | "remove" | "exists" | "claimProfile" | "removalSnapshot" | "writeRemovalReceipt" | "claimServiceOperation">
type ServiceRemovalResult = ServiceRemovalPlan & {
  profileRecovery: "recorded" | "operator-confirmation-required" | "proof-unavailable" | "not-needed"
  profileRecoveryDetail?: string
}

// Only a failure raised while the Task Scheduler adapter holds the deadline is
// a task removal failure. Refusals before it (exclusion, SystemRoot) and after
// it (profile ownership) never touched the task and keep their own message.
type RemovalProgress = { managerHoldsDeadline: boolean }

async function removeWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: RemovalEffects,
  deadline: OperationDeadline,
  progress: RemovalProgress,
): Promise<ServiceRemovalResult> {
  const plan = serviceRemovalPlan(target)
  const home = assertHome(target.home)
  deadline.throwIfExpired()
  const before = effects.removalSnapshot(home, target.platform)
  let managerStopped = true
  if (plan.kind === "task") {
    progress.managerHoldsDeadline = true
    managerStopped = await removeWindowsTask(plan, effects, deadline) === "removed"
    progress.managerHoldsDeadline = false
  }
  for (const { command, args } of plan.kind === "file" ? plan.commands : []) {
    try {
      await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
    } catch (error) {
      // A manager that refuses to stop a service it does not know about must
      // not keep the file from going away. Every other failure must preserve
      // the unit: deleting it while a live manager still owns the service
      // strands a process and falsely reports a successful removal.
      if (!isMissingServiceFailure(target.platform, error)) throw error
      managerStopped = false
    }
  }
  deadline.throwIfExpired()
  const profile = profileLocation(home, before.profileDirectory)
  const lease = effects.claimProfile(profile)
  try {
    const recovery = serviceRemovalRecovery(before, effects.removalSnapshot(home, target.platform), managerStopped)
    const files = [
      ...(plan.kind === "file" ? [plan.path] : []),
      serviceConfigurationPath(home, target.platform),
    ]
    for (const path of files) {
      if (await withinServiceDeadline(deadline, () => effects.exists(path, deadline))) {
        await withinServiceDeadline(deadline, () => effects.remove(path, deadline))
      }
    }
    deadline.throwIfExpired()
    if (recovery.kind === "receipt") effects.writeRemovalReceipt(profile, lease, serviceRemovalReceipt(recovery, target.platform), deadline)
    return {
      ...plan,
      profileRecovery: recovery.kind === "receipt" ? "recorded" : recovery.kind,
      ...(recovery.kind === "proof-unavailable" ? { profileRecoveryDetail: recovery.reason } : {}),
    }
  } finally {
    // A late config deletion must not outlive the lease and erase a successor's
    // launch settings. On expiry the CLI retains it until process exit.
    if (!deadline.signal.aborted) lease.release()
  }
}

export function removeService(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: RemovalEffects,
): Promise<ServiceRemovalResult> {
  const progress: RemovalProgress = { managerHoldsDeadline: false }
  return serviceOperation(effects, (deadline) => removeWithDeadline(target, effects, deadline, progress)).catch((cause: unknown) => {
    // The outer deadline can expire before the manager adapter settles. It
    // needs the same actionable task-specific error, not a bare timer failure.
    if (progress.managerHoldsDeadline && !(cause instanceof WindowsTaskRemovalError)) {
      throw new WindowsTaskRemovalError(displayName, cause)
    }
    throw cause
  })
}

async function statusWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists" | "supervisorStatus">,
  deadline: OperationDeadline,
): Promise<ServiceStatus> {
  if (target.platform === "linux") {
    const supervisor = await withinServiceDeadline(deadline, async () => effects.supervisorStatus?.(assertHome(target.home)))
    if (supervisor !== undefined) return supervisor
    const path = unitPath(target.home)
    const installed = await withinServiceDeadline(deadline, () => effects.exists(path, deadline))
    const active = await withinServiceDeadline(deadline, () => effects.capture("systemctl", ["--user", "is-active", unitFile], deadline))
    if (![0, 3, 4].includes(active.code)) throw captureFailure("systemctl", active)
    const state = active.stdout.trim() === "" ? "unknown" : active.stdout.trim()
    return {
      installed,
      running: active.code === 0,
      detail: installed ? `${path} is ${state}` : `no service file at ${path}`,
    }
  }

  if (target.platform === "darwin") {
    const path = agentPath(target.home)
    const installed = await withinServiceDeadline(deadline, () => effects.exists(path, deadline))
    const printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", [
      "print",
      `gui/${assertUid(target.uid)}/${agentLabel}`,
    ], deadline))
    // print answers 113 for an absent service. Other failures cannot become
    // absence merely because their diagnostics happen to mention the label.
    if (printed.code !== 0 && (printed.code !== 113 || !isMissingServiceFailure("darwin", printed))) {
      throw captureFailure("launchctl", printed)
    }
    let state: string | undefined
    if (printed.code === 0) {
      // launchctl indents job fields with one tab; nested blocks repeat state.
      // Refuse an unreadable format instead of treating loadedness as liveness.
      const states = [...printed.stdout.matchAll(/^\tstate = ([^\r\n]+)\r?$/gm)]
      state = states[0]?.[1]?.trim()
      if (states.length !== 1 || !state) throw new Error("launchctl did not report one agent runtime state")
    }
    return {
      installed,
      running: state === "running",
      detail: installed
        ? `${path} is ${state === undefined ? "not loaded" : `loaded (${state})`}`
        : `no launch agent at ${path}`,
    }
  }

  if (target.platform === "win32") {
    const state = await readWindowsTaskState(displayName, effects, deadline)
    const installed = state !== "missing"
    const running = state === "4"
    return {
      installed,
      running,
      detail: installed
        ? `${displayName} is ${running ? "running" : "registered but not running"}`
        : `no logon task named ${displayName}`,
    }
  }

  throw new Error(`${target.platform} has no service manager this knows how to report on`)
}

export function serviceStatus(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists" | "claimServiceOperation" | "supervisorStatus">,
): Promise<ServiceStatus> {
  return serviceOperation(effects, (deadline) => statusWithDeadline(target, effects, deadline))
}

const usage = `Usage: domovoid service install
       domovoid service status
       domovoid service remove
`

export type ServiceCommandDependencies = ServiceEffects & {
  platform: string
  execPath: string
  runtime?: string
  home?: string
  uid?: number
  user?: string
  environment?: DaemonEnvironment
  workingDirectory?: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

// The command is the only thing here that talks to a person: it reports where
// the service went, what the service manager said when it refused, and never
// invents a success.
export async function runServiceCommand(
  args: readonly string[],
  dependencies: ServiceCommandDependencies,
): Promise<number> {
  if (args[0] !== "service") return 1
  const verb = args[1]
  if (args.length > 2 || verb === undefined || !["install", "status", "remove"].includes(verb)) {
    dependencies.stderr(usage)
    return 1
  }

  const target = {
    platform: dependencies.platform,
    execPath: dependencies.execPath,
    ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
    ...(dependencies.uid === undefined ? {} : { uid: dependencies.uid }),
    ...(dependencies.user === undefined ? {} : { user: dependencies.user }),
  }

  try {
    const savedWsl = dependencies.platform === "linux"
      && dependencies.readConfiguration?.(assertHome(dependencies.home), "linux")?.wsl !== undefined
    const installingFromWsl = verb === "install" && (dependencies.environment?.WSL_DISTRO_NAME !== undefined
      || dependencies.environment?.WSL_INTEROP !== undefined)
    if (dependencies.platform === "linux" && (savedWsl || installingFromWsl)) {
      return await serviceOperation(dependencies, (deadline) => runWslServiceCommand(verb, dependencies, deadline))
    }
    if (verb === "install") {
      const configuration = createServiceConfiguration(dependencies.environment ?? {}, {
        platform: dependencies.platform,
        homeDirectory: assertHome(dependencies.home),
        workingDirectory: dependencies.workingDirectory ?? process.cwd(),
      })
      const plan = await installService({ ...target, configuration }, dependencies)
      dependencies.stdout(
        plan.kind === "file"
          ? `Installed the Domovoi daemon service at ${plan.path}\n`
          : `Installed the Domovoi daemon service as ${serviceName}\n`,
      )
      return 0
    }

    if (verb === "remove") {
      const plan = await removeService(target, dependencies)
      dependencies.stdout(
        plan.kind === "file"
          ? `Removed the Domovoi daemon service at ${plan.path}\n`
          : `Removed the Domovoi daemon service ${displayName}\n`,
      )
      if (plan.profileRecovery === "operator-confirmation-required") {
        dependencies.stdout("The profile owner remains unresolved. After confirming no custom or legacy supervisor will restart it, run domovoid profile recover --confirm-no-supervisor.\n")
      }
      if (plan.profileRecovery === "proof-unavailable") {
        dependencies.stdout(`${plan.profileRecoveryDetail}. No recovery receipt was written. Repair or inspect that file, then after confirming no custom or legacy supervisor will restart the daemon, run domovoid profile recover --confirm-no-supervisor.\n`)
      }
      return 0
    }

    const status = await serviceStatus(target, dependencies)
    if (status.installed === null) {
      dependencies.stdout(`Windows task registration unverified: ${status.detail}\n`)
      return status.supervisionFailure === undefined ? 0 : 1
    }
    const installed = status.installed ? "installed" : "not installed"
    const running = status.running ? "running" : "not running"
    dependencies.stdout(`${installed}, ${running}: ${status.detail}\n`)
    return status.installed ? 0 : 1
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export function nodeServiceEffects(options: { userHomeDirectory?: string } = {}): ServiceEffects {
  return {
    readConfiguration: (home, platform) => {
      try { return parseServiceConfiguration(readLocalProfileFile(serviceConfigurationPath(home, platform), 64 * 1024)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    },
    stopSupervisor: stopGuestSupervisor,
    // Manager names are per OS user, not per caller-selected HOME or profile.
    // An alternate shell HOME must not create a second lock for the same job.
    // The override isolates tests from the operator's actual service lock.
    claimServiceOperation: () => claimServiceOperation(options.userHomeDirectory ?? userInfo().homedir),
    claimProfile,
    registeredProfile: (home, platform) => {
      let text: string
      try { text = readLocalProfileFile(serviceConfigurationPath(home, platform), 64 * 1024) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
      const saved = parseServiceConfiguration(text)
      return profileLocation(saved.homeDirectory, saved.profileDirectory)
    },
    removalSnapshot: readServiceRemovalSnapshot,
    writeRemovalReceipt: writeLocalOwnerRemovalReceipt,
    supervisorStatus: async (home) => readGuestSupervisorStatus(home),
    write: writeUnit,
    // A service file or update record is read only as a bounded private
    // regular file owned by this user, without following a link, as
    // service.json is: what it names is registered and started on a rollback.
    read: async (path, deadline) => {
      deadline.throwIfExpired()
      return readLocalProfileFile(path, 64 * 1024)
    },
    readOwner: readLocalOwnerRecord,
    run: async (command, args, deadline) => {
      const { execFile } = await import("node:child_process")
      deadline.throwIfExpired()
      await new Promise<void>((resolve, reject) => {
        execFile(command, args, { signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()), killSignal: "SIGKILL" }, (error) => (error ? reject(error) : resolve()))
      })
    },
    capture: async (command, args, deadline) => {
      const { execFile } = await import("node:child_process")
      deadline.throwIfExpired()
      return new Promise<CapturedRun>((resolve) => {
        execFile(command, args, { signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()), killSignal: "SIGKILL" }, (error, stdout, stderr) => {
          const failure = error as (Error & { code?: unknown }) | null
          const code = typeof failure?.code === "number" ? failure.code : failure ? 1 : 0
          resolve({
            code,
            stdout: stdout.toString(),
            stderr: stderr.toString() || failure?.message || "",
          })
        })
      })
    },
    exists: async (path, deadline) => {
      try {
        await withinServiceDeadline(deadline, () => stat(path))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
    },
    remove: async (path, deadline) => {
      await withinServiceDeadline(deadline, () => rm(path, { force: true }))
    },
  }
}
