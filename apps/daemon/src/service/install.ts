import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, posix, win32 } from "node:path"
import { userInfo } from "node:os"
import { replaceFile } from "@getdomovoi/credential-store"
import { loginServiceAgentLabel, loginServiceHomePaths, loginServiceTaskName, loginServiceUnitFile } from "@getdomovoi/protocol"
import { installedWslTask } from "./wsl-registration.js"
import { runWslServiceCommand } from "./wsl-install.js"
import { stopGuestSupervisor } from "./supervisor-command.js"

import type { DaemonEnvironment } from "../config.js"
import type { FileLease } from "../file-lease.js"
import { OperationDeadline } from "../operation-deadline.js"
import { claimProfile, ProfileAlreadyOwnedError, type ProfileLease } from "../profile-lease.js"
import { localOwnerRemovalReceiptPath, writeLocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { readServiceRemovalSnapshot, serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { assertServiceProfile, createServiceConfiguration, registeredWithoutConfiguration, ServiceProfileUnknownError, parseServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration, type ServiceRuntimeRecord } from "./configuration.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { withinServiceDeadline } from "./deadline.js"
import { claimServiceOperation, claimServiceStatusRead } from "./operation-lease.js"
import { launchdPlist, launchdPlistProgram, systemdUnit, systemdUnitProgram } from "./units.js"
import { isRecordedServiceProgram } from "./restore-target.js"
import { disableWindowsTask, readWindowsTaskAction, readWindowsTaskState, removeWindowsTask, stopWindowsTask, WindowsTaskRemovalError, windowsSchtasksPath, windowsTaskDisabledAndIdle, windowsTaskRemovalPlan, windowsTaskSettingsCommand, type WindowsTaskAction, type WindowsTaskRemovalPlan } from "./windows-task.js"
import { claimProfileAfterStop, currentInstance, DaemonServiceUpdateError, OwnerInstances, releaseWhenSettled, seconds, within, type InFlight, type ServiceSwap } from "./update-outcome.js"
import { readLocalOwnerRecord, type LocalOwnerRecord } from "../local-owner-record.js"
import { readWindowsSupervisorStatus, stopWindowsSupervisor, windowsTreeUnknown } from "./windows-job-supervisor.js"
import { readGuestSupervisorStatus } from "./supervisor-command.js"
import { profileDirectory, profileLocation, sameProfileDirectory, type ProfileLocation } from "../profile-directory.js"
import { bundledServiceRuntime } from "./bundled-runtime.js"
import type { RuntimeFileSystem } from "./runtime-stage.js"
import type { DaemonServiceRuntimeReader } from "./desktop-service.js"
import { disableLinger, enableLinger, lingerAfterRestore, lingerInstallLine, lingerRecord, lingerRemovalLine, type LingerInstallOutcome, type LingerRemovalOutcome } from "./linger.js"

const serviceName = "domovoid"
const unitFile = loginServiceUnitFile
const agentLabel = loginServiceAgentLabel
const displayName = loginServiceTaskName

// Microsoft documents 262, but schtasks's own /TR error limits it to 261:
// https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create
// https://adventuresinscm.wordpress.com/2014/06/22/error-value-for-tr-option-cannot-be-more-than-261-characters/
const windowsTaskCommandLengthLimit = 261

export type ServiceCommand = { command: string; args: string[] }

type ServiceRegistrationPlan =
  | { kind: "file"; path: string; contents: string; commands: ServiceCommand[] }
  | { kind: "task"; commands: ServiceCommand[] }

export type ServicePlan = ServiceRegistrationPlan & {
  configuration: { path: string; contents: string }
}

// An install's plan as carried out, with what happened to Linux lingering.
export type InstalledService = ServicePlan & { linger?: LingerInstallOutcome }

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
  stopSupervisor?: (path: string, deadline: OperationDeadline, options?: { retire?: boolean; previousConfigurationDigest?: string; confirmNoLaunch?: () => Promise<boolean>; stopTask?: () => Promise<boolean> }) => Promise<unknown>
  claimServiceOperation: {
    (): FileLease
    (access: "status"): FileLease | undefined
  }
  claimProfile: (homeDirectory: ProfileLocation) => ProfileLease
  registeredProfile?: (home: string, platform: string) => ProfileLocation | undefined
  removalSnapshot: typeof readServiceRemovalSnapshot
  writeRemovalReceipt: typeof writeLocalOwnerRemovalReceipt
  write: (path: string, contents: string, deadline: OperationDeadline) => Promise<void>
  // Reads a service file back, so a failed install, or an update, can
  // restore it.
  read?: (path: string, deadline: OperationDeadline) => Promise<string>
  // The daemon's local owner record: which instance holds the profile, and
  // whether it reports ready.
  readOwner?: (profile: ProfileLocation) => LocalOwnerRecord | undefined
  run: (command: string, args: string[], deadline: OperationDeadline) => Promise<void>
  capture: (command: string, args: string[], deadline: OperationDeadline) => Promise<CapturedRun>
  exists: (path: string, deadline: OperationDeadline) => Promise<boolean>
  remove: (path: string, deadline: OperationDeadline) => Promise<void>
  supervisorStatus?: (home: string, deadline?: OperationDeadline) => Promise<ServiceStatus | undefined>
}

export type ServiceStatus = {
  installed: boolean | null
  running: boolean
  detail: string
  supervising?: boolean
  treeUnconfirmed?: boolean
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

export function isMissingServiceFailure(platform: string, error: unknown): boolean {
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

// Security review round 2 (#574): launchd binds a label to whichever plist
// was bootstrapped, so a job named sh.domovoi.domovoid is Domovoi's only when
// launchctl says it came from Domovoi's plist. launchctl indents job fields
// with one tab. Text ruled 2026-09-25.
function launchdJobPath(printed: string): string {
  const paths = [...printed.matchAll(/^\tpath = ([^\r\n]+)\r?$/gm)]
  const path = paths[0]?.[1]?.trim()
  if (paths.length !== 1 || !path) throw new Error("launchctl did not say which file the loaded sh.domovoi.domovoid job came from")
  return path
}

// Security review round 3 (#574): launchd refuses to bootstrap a label that
// is still loaded. A job loaded from another plist is not Domovoi's to boot
// out, so the install stops before the handoff.
// Text ruled 2026-09-25.
export class LaunchdJobNotDomovoiError extends Error {
  constructor(readonly path: string) {
    super(`A job named sh.domovoi.domovoid is loaded from ${path}, which is not Domovoi's launch agent. Nothing was stopped or changed.`)
    this.name = "LaunchdJobNotDomovoiError"
  }
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
  return posix.join(assertHome(home), loginServiceHomePaths.linux)
}

function agentPath(home: string | undefined): string {
  return posix.join(assertHome(home), loginServiceHomePaths.darwin)
}

// A service is installed for the user who asked for it: a systemd user unit, a
// launchd agent in that user's own LaunchAgents, or a Windows logon task.
// Nothing here writes to a system-wide location or asks for elevation.
function windowsTaskCommand(execPath: string, runtime: string | undefined): string {
  const target = assertExecutable(execPath)
  // Security review round 1 (#574): a named runtime always runs the entry,
  // whatever its extension. The entry was checked as a file Node reads, not
  // as a program Windows could start on its own.
  if (runtime !== undefined) return `"${assertExecutable(runtime)}" "${target}"`
  if (/\.[cm]?js$/i.test(target)) {
    throw new Error("a Windows task that runs a script needs the Node executable that runs it")
  }
  return `"${target}"`
}

// Security review round 1 (#574): Task Scheduler expands %NAME% in a task
// action's program and arguments each time the task runs, and schtasks has no
// way to write a literal percent sign. A path that contains one could run a
// file other than the one checked, so it is refused before anything changes.
// Text ruled 2026-09-25.
export class WindowsTaskPercentSignError extends Error {
  constructor(readonly path: string) {
    super(`${path} contains a percent sign, which Task Scheduler reads as an environment variable when the task runs. No service files were changed.`)
    this.name = "WindowsTaskPercentSignError"
  }
}

// Security review round 3 (#574): status and removal recognise a task only
// by paths in the plain form Windows reports (plainWindowsPath), so install
// refuses any other form rather than register a task it could not recognise
// or remove later. Text ruled 2026-09-25.
export class WindowsTaskPathError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not in the plain form Windows reports for it (no . or .. parts, no doubled or forward slashes, no DEL character), so Domovoi could not recognise the task later. No service files were changed.`)
    this.name = "WindowsTaskPathError"
  }
}

type WindowsTaskCommandPart = "Node runtime" | "daemon entry" | "daemon program" | "service configuration"

export class WindowsTaskCommandLengthError extends Error {
  constructor(readonly length: number, readonly part: WindowsTaskCommandPart, readonly path: string) {
    super(`The Windows task command is ${length} characters, and schtasks accepts at most ${windowsTaskCommandLengthLimit}. Its longest part is the ${part} ${path} (${path.length} characters). Install Node and Domovoi at shorter absolute paths before installing the service. No service files were changed.`)
    this.name = "WindowsTaskCommandLengthError"
  }
}

// Security review round 5 (#574): systemd expands $ variables and %
// specifiers in ExecStart. The unit doubles them, but whether systemd undoes
// that in the executable slot is not certain, so a path that contains one is
// refused before anything changes, as on Windows. A backslash is left to the
// unit's quoting: the non-native systemd safety tests install with a Windows
// host's own paths, and refusing it here would make them unrunnable there.
// Text ruled 2026-09-25.
const systemdExpansions: Record<string, string> = { "$": "a variable", "%": "a specifier" }

export function refuseSystemdPath(path: string): void {
  const character = [...path].find((c) => c in systemdExpansions)
  if (character !== undefined) throw new SystemdPathCharacterError(path, character)
}

// Task Scheduler expands %NAME% and substitutes $( in an action's program and
// arguments when the task runs (security review rounds 1 and 2 on #574).
export function refuseTaskSchedulerExpansion(value: string): void {
  if (value.includes("%")) throw new WindowsTaskPercentSignError(value)
  if (value.includes("$(")) throw new WindowsTaskArgumentVariableError(value)
}

export class SystemdPathCharacterError extends Error {
  constructor(readonly path: string, readonly character: string) {
    super(`${path} contains ${character}, which systemd reads as ${systemdExpansions[character] ?? "a special character"} when the service starts. No service files were changed.`)
    this.name = "SystemdPathCharacterError"
  }
}

// Security review round 2 (#574): Task Scheduler substitutes $(Arg0) through
// $(Arg32) in an action's arguments when the task runs with parameters, so any
// $( is refused before anything changes, as the percent sign is.
// Text ruled 2026-09-25.
export class WindowsTaskArgumentVariableError extends Error {
  constructor(readonly path: string) {
    super(`${path} contains $(, which Task Scheduler reads as a task argument when the task runs. No service files were changed.`)
    this.name = "WindowsTaskArgumentVariableError"
  }
}

// The program a launchd agent or systemd unit runs and its arguments, as an
// install writes them: the runtime, the daemon entry, and the saved
// configuration. The runtime version reader compares a definition with it.
export function serviceProgram(execPath: string, runtime: string | undefined, configurationPath: string): { program: string; args: string[] } {
  const serviceArgs = ["--service-config", configurationPath]
  return runtime === undefined ? { program: execPath, args: serviceArgs } : { program: runtime, args: [execPath, ...serviceArgs] }
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
  // Ruled 2026-09-24 (A): the runtime and daemon entry the service runs are
  // recorded in service.json, so an update can tell what Domovoi installed
  // without trusting the service definition. A WSL guest install records its
  // own (runWslServiceCommand); a service with no separate entry has nothing
  // an update could put back, and records nothing.
  const recorded = configuration.wsl || runtime === undefined
    ? configuration
    : { ...configuration, serviceRuntime: { executable: runtime, entry: execPath } }
  const configurationFile = {
    path: serviceConfigurationPath(configuration.homeDirectory, platform),
    contents: serializeServiceConfiguration(recorded),
  }
  // The configured home owns the per-user registration. The daemon profile
  // is explicit saved configuration, not a replacement provider HOME.
  if (home !== configuration.homeDirectory) throw new Error("The service configuration must belong to the installing user home")
  if (configuration.wsl) {
    if (platform !== "linux" || !configuration.registrationId) throw new Error("WSL service requires a guest registration")
    const task = installedWslTask(configuration.wsl, configuration.registrationId, configurationFile.path)
    return { kind: "task", configuration: configurationFile, commands: [task.register, task.start] }
  }
  const { program, args } = serviceProgram(execPath, runtime, configurationFile.path)
  if (platform === "linux") {
    for (const path of [runtime, execPath, configurationFile.path]) {
      if (path !== undefined) refuseSystemdPath(path)
    }
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
    for (const path of [runtime, execPath, configurationFile.path]) {
      if (path?.includes("%")) throw new WindowsTaskPercentSignError(path)
      if (path?.includes("$(")) throw new WindowsTaskArgumentVariableError(path)
    }
    const taskCommand = `${windowsTaskCommand(execPath, runtime)} --service-supervise "${assertExecutable(configurationFile.path, "the service configuration")}"`
    for (const path of [runtime, execPath, configurationFile.path]) {
      if (path !== undefined && !plainWindowsPath(path)) throw new WindowsTaskPathError(path)
    }
    if (taskCommand.length > windowsTaskCommandLengthLimit) {
      let part: WindowsTaskCommandPart = runtime === undefined ? "daemon program" : "Node runtime"
      let path = runtime ?? execPath
      if (runtime !== undefined && execPath.length > path.length) {
        part = "daemon entry"
        path = execPath
      }
      if (configurationFile.path.length > path.length) {
        part = "service configuration"
        path = configurationFile.path
      }
      throw new WindowsTaskCommandLengthError(taskCommand.length, part, path)
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
          // Under SystemRoot, never a schtasks found by name (review F3).
          command: windowsSchtasksPath(),
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
        // No 72 hour limit or battery stops for the daemon (windows-task.ts).
        windowsTaskSettingsCommand(displayName),
        { command: windowsSchtasksPath(), args: ["/run", "/tn", displayName] },
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
    // and no rename starts after the deadline. Windows refuses to replace
    // service.json while the supervisor or a status read holds it open; the
    // rename retries that for at most five seconds, inside the deadline.
    deadline.throwIfExpired()
    await writeFile(staging, contents, { flag: "wx", mode: 0o600, signal: deadline.signal })
    deadline.throwIfExpired()
    await replaceFile(staging, path, { rename }, { deadline })
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

async function serviceOperation<T>(effects: { claimServiceOperation: () => FileLease | undefined }, operation: (deadline: OperationDeadline) => Promise<T>): Promise<T> {
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
// Security review round 2 (#574): the handoff must not stop the in-app daemon
// when the install would then be refused because another daemon owns the
// profile. A profile that can be claimed is free, and the probe lets it go at
// once, so it is claimed for the service only after the handoff. A profile
// already owned passes only when its owner record names a desktop owner, the
// in-app daemon the handoff stops. Any other owner, no record, or a record
// that cannot be read refuses with the profile's own error.
function checkProfileBeforeHandoff(profile: ProfileLocation, effects: Pick<ServiceEffects, "claimProfile" | "readOwner">): void {
  let probe: ProfileLease
  try {
    probe = effects.claimProfile(profile)
  } catch (error) {
    if (!(error instanceof ProfileAlreadyOwnedError)) throw error
    let record: LocalOwnerRecord | undefined
    try { record = effects.readOwner?.(profile) } catch { throw error }
    if (record === undefined || record.state === "none" || record.owner !== "desktop") throw error
    return
  }
  probe.release()
}

// Another daemon took the profile after the check and after the in-app daemon
// was stopped. Nothing was claimed or written; the in-app daemon stays
// stopped, and the desktop can attach to whichever daemon owns the profile.
// Text ruled 2026-09-25.
export class DaemonServiceHandoffError extends Error {
  constructor(cause: ProfileAlreadyOwnedError) {
    super("Another Domovoi daemon took the profile after this app stopped its own daemon. No service was installed and no service files were changed.", { cause })
    this.name = "DaemonServiceHandoffError"
  }
}

type InstallEffects = Pick<ServiceEffects, "write" | "read" | "run" | "capture" | "exists" | "claimProfile" | "remove" | "registeredProfile" | "readOwner" | "readConfiguration" | "supervisorStatus" | "stopSupervisor">

// Security review round 3 (#574): what the service files held before this
// install, so a manager that refuses the new definition leaves the record
// naming what it still runs. Undefined when this caller cannot read files.
type PreviousFiles = { path: string; contents: string | undefined }[] | undefined

async function readPreviousFiles(plan: ServicePlan, effects: InstallEffects, deadline: OperationDeadline): Promise<PreviousFiles> {
  const read = effects.read
  if (!read) return undefined
  const previous: { path: string; contents: string | undefined }[] = []
  for (const path of [plan.configuration.path, ...(plan.kind === "file" ? [plan.path] : [])]) {
    const present = await withinServiceDeadline(deadline, () => effects.exists(path, deadline))
    previous.push({ path, contents: present ? await withinServiceDeadline(deadline, () => read(path, deadline)) : undefined })
  }
  return previous
}

// Text ruled 2026-09-25.
function restoreFailure(cause: unknown, restoreCause: unknown): Error {
  const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().replace(/\.+$/u, "")
  return new Error(`${detail(cause)}. Putting back the previous service files also failed: ${detail(restoreCause)}.`, { cause: restoreCause })
}

async function putPreviousFilesBack(previous: NonNullable<PreviousFiles>, effects: InstallEffects, deadline: OperationDeadline, cause: unknown): Promise<void> {
  try {
    for (const { path, contents } of previous) {
      if (contents === undefined) await withinServiceDeadline(deadline, () => effects.remove(path, deadline))
      else await withinServiceDeadline(deadline, () => effects.write(path, contents, deadline))
    }
  } catch (restoreCause) {
    throw restoreFailure(cause, restoreCause)
  }
}

// Security review rounds 4 and 5 (#574): the install sent a bootout for
// Domovoi's own idle job, and a later step failed, or the bootout itself
// reported failure after it unloaded the job. If launchd no longer lists the
// job, the previous plist, now back in place, is loaded again: launchd is
// left with the job it had. A job still listed is left as it is.
async function loadPreviousAgent(target: ServiceTarget, plan: ServicePlan, previous: NonNullable<PreviousFiles>, effects: InstallEffects, deadline: OperationDeadline, cause: unknown): Promise<void> {
  const job = `gui/${assertUid(target.uid)}/${agentLabel}`
  let printed: CapturedRun
  try {
    printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", job], deadline))
  } catch (restoreCause) {
    throw restoreFailure(cause, restoreCause)
  }
  const path = plan.kind === "file" ? plan.path : undefined
  if (printed.code === 0) {
    // Security review round 6: a job listed under the label is the previous
    // agent only when it came from Domovoi's plist. A job from another plist
    // took the label, so the previous agent could not be loaded again. The
    // approved foreign-job line's last sentence, "Nothing was stopped or
    // changed.", is not true here, so only its first sentence is used.
    let loadedFrom: string
    try {
      loadedFrom = launchdJobPath(printed.stdout)
    } catch (restoreCause) {
      throw restoreFailure(cause, restoreCause)
    }
    if (loadedFrom === path) return
    throw restoreFailure(cause, new Error(`A job named sh.domovoi.domovoid is loaded from ${loadedFrom}, which is not Domovoi's launch agent`))
  }
  if (printed.code !== 113 || !isMissingServiceFailure("darwin", printed)) throw restoreFailure(cause, captureFailure("launchctl", printed))
  if (path === undefined || previous.find((file) => file.path === path)?.contents === undefined) {
    throw restoreFailure(cause, new Error("the previous launch agent file was not there to load again"))
  }
  try {
    await withinServiceDeadline(deadline, () => effects.run("launchctl", ["bootstrap", `gui/${assertUid(target.uid)}`, path], deadline))
  } catch (restoreCause) {
    throw restoreFailure(cause, restoreCause)
  }
}

// The command that makes the manager adopt the new definition. A failure up
// to and including it leaves the manager on what it ran before; after it, the
// new definition is the registered one.
function registersDefinition({ command, args }: ServiceCommand): boolean {
  return (win32.basename(command).toLowerCase() === "schtasks.exe" && args[0] === "/create")
    || (command === "launchctl" && args[0] === "bootstrap")
    || (command === "systemctl" && args.includes("daemon-reload"))
}

// Security review round 3 (#574): launchd refuses a bootstrap while the label
// is loaded. A job loaded from Domovoi's plist is booted out first; one loaded
// from another plist refuses the install before the handoff. A running job
// from Domovoi's plist holds the profile, so the profile check refuses it.
async function launchdCommandsBeforeInstall(target: ServiceTarget, plan: ServicePlan, effects: InstallEffects, deadline: OperationDeadline): Promise<ServiceCommand[]> {
  if (target.platform !== "darwin" || plan.kind !== "file") return []
  const job = `gui/${assertUid(target.uid)}/${agentLabel}`
  const printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", job], deadline))
  if (printed.code === 113 && isMissingServiceFailure("darwin", printed)) return []
  if (printed.code !== 0) throw captureFailure("launchctl", printed)
  const loadedFrom = launchdJobPath(printed.stdout)
  if (loadedFrom !== plan.path) throw new LaunchdJobNotDomovoiError(loadedFrom)
  return [{ command: "launchctl", args: ["bootout", job] }]
}

// Security review round 4 of #577 (P1): where the service manager holds a
// Domovoi registration, read from the manager rather than only the definition
// file: the definition at Domovoi's path, a job or unit loaded under Domovoi's
// name after its file was deleted, or one under another name in Domovoi's
// namespace (sh.domovoi.* on launchd, domovoi* units on systemd). Undefined
// when there is none. Limit: a job under an unrelated name that runs Domovoi
// is not found. Used only where no saved configuration names the profile.
async function registeredServiceWithoutConfiguration(
  target: Pick<ServiceTarget, "platform" | "uid">,
  plan: { kind: string; path?: string },
  effects: Pick<ServiceEffects, "exists" | "capture">,
  deadline: OperationDeadline,
): Promise<string | undefined> {
  if (plan.kind !== "file" || plan.path === undefined) return undefined
  const path = plan.path
  if (await withinServiceDeadline(deadline, () => effects.exists(path, deadline))) return path
  if (target.platform === "darwin") {
    const domain = `gui/${assertUid(target.uid)}`
    const job = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", `${domain}/${agentLabel}`], deadline))
    if (job.code === 0) return `${domain}/${agentLabel}`
    if (job.code !== 113 || !isMissingServiceFailure("darwin", job)) throw captureFailure("launchctl", job)
    const listed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", domain], deadline))
    if (listed.code !== 0) throw captureFailure("launchctl", listed)
    // Rounds 5 and 6 (P1): the domain listing is read whole. It must open
    // with this domain, close every block it opens, and hold one services
    // block; in that block each row has a pid or "-" first and the label last,
    // whatever columns launchd puts between. A row that names Domovoi anywhere
    // but as its one, last field is ambiguous (a label may hold a space).
    // Anything else refuses rather than pass as having no Domovoi job. Copy
    // approved by fetzy on 2026-09-26.
    const unreadable = () => new ServiceProfileUnknownError(`launchd listed the jobs in ${domain} in a form this app cannot read, so whether a login service is registered there is not known.`)
    const lines = listed.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u).map((line) => line.trimEnd())
    if (lines[0] !== `${domain} = {`) throw unreadable()
    let depth = 0
    let services: string[] | undefined
    let inServices = false
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim()
      if (inServices && trimmed !== "}") {
        services!.push(trimmed)
        continue
      }
      if (trimmed.endsWith("{")) {
        depth += 1
        if (depth === 2 && trimmed === "services = {") {
          if (services !== undefined) throw unreadable()
          services = []
          inServices = true
        }
      } else if (trimmed === "}") {
        depth -= 1
        inServices = false
        if (depth < 0 || (depth === 0 && index !== lines.length - 1)) throw unreadable()
      }
    }
    if (depth !== 0 || services === undefined) throw unreadable()
    for (const row of services) {
      if (row === "") continue
      const fields = row.split(/\s+/u)
      if (fields.length < 3 || !/^(?:\d+|-)$/u.test(fields[0]!)) throw unreadable()
      const naming = fields.filter((field) => field.includes("domovoi"))
      if (naming.length === 0) continue
      const label = fields.at(-1)!
      if (naming.length !== 1 || naming[0] !== label || !label.startsWith("sh.domovoi.")) throw unreadable()
      return `${domain}/${label}`
    }
    return undefined
  }
  if (target.platform === "linux") {
    const listed = await withinServiceDeadline(deadline, () => effects.capture("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "--full", "domovoi*"], deadline))
    if (listed.code !== 0) throw captureFailure("systemctl", listed)
    return /^(domovoi\S*)\s/mu.exec(listed.stdout)?.[1]
  }
  return undefined
}

// Round 4 (P3): a saved configuration that cannot be read or parsed names no
// profile; a caller's install refuses on it with the specific refusal.
function unknownSavedProfile(path: string, cause: unknown): ServiceProfileUnknownError {
  const code = (cause as NodeJS.ErrnoException).code
  const reason = code === undefined
    ? `The saved service configuration at ${path} is not a Domovoi service configuration.`
    : `The saved service configuration at ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`
  return new ServiceProfileUnknownError(`${reason} The profile the login service runs is not known.`)
}

async function installWithDeadline(
  target: ServiceTarget,
  effects: InstallEffects,
  deadline: OperationDeadline,
  words: ServiceCommandWords,
  handoff: (() => Promise<void>) | undefined,
  callerProfile?: ProfileLocation,
  beforeChanges?: () => Promise<void>,
): Promise<InstalledService> {
  // Reinstalling is a new supervisor decision, not reuse of an old recovery
  // authorization. Assign the identity here, even if the caller supplied one.
  let plan: InstalledService = servicePlan({ ...target, configuration: { ...target.configuration, registrationId: randomUUID() } })
  deadline.throwIfExpired()
  const profile = profileLocation(target.configuration.homeDirectory, target.configuration.profileDirectory, target.platform)
  let previous: ProfileLocation | undefined
  try {
    previous = effects.registeredProfile?.(target.configuration.homeDirectory, target.platform)
  } catch (cause) {
    if (callerProfile === undefined) throw cause
    throw unknownSavedProfile(serviceConfigurationPath(target.configuration.homeDirectory, target.platform), cause)
  }
  // Security review round 2 of #577: read under the service-operation lease,
  // before the handoff, so a service saved for another profile meanwhile
  // refuses the caller's install.
  if (callerProfile !== undefined) {
    // Round 3: a registered service with no saved configuration runs a
    // profile nothing names; the caller's install does not replace it.
    if (previous === undefined) {
      const registered = await registeredServiceWithoutConfiguration(target, plan, effects, deadline)
      if (registered !== undefined) throw registeredWithoutConfiguration(registered)
    }
    assertServiceProfile(previous, callerProfile, target.platform)
  }
  // Security review round 3 (#574): schtasks /create /f replaces a task of
  // the same name, so a task Domovoi did not register refuses the install, by
  // the same check status and removal use, before anything changes.
  let legacyWindowsCommand: string | undefined
  let restoreSupervisedWindows: (() => Promise<void>) | undefined
  if (target.platform === "win32" && !target.configuration.wsl) {
    const owner = await windowsTaskOwner(assertHome(target.home), effects, deadline)
    if (owner === "other") throw new WindowsTaskNotDomovoiError(displayName)
    if (owner === "domovoi") {
      const action = await readWindowsTaskAction(displayName, effects, deadline)
      if (action === "missing" || !action.arguments.includes('" --service-config "')) throw new Error("Legacy Windows registration changed before migration")
      legacyWindowsCommand = domovoiTaskCommand(action, plan.configuration.path, effects.readConfiguration?.(assertHome(target.home), "win32")?.serviceRuntime)
      if (!legacyWindowsCommand) throw new WindowsTaskNotDomovoiError(displayName)
      // Q10 B: legacy tasks retain scheduler-only retirement. Keep the stopped
      // registration until the new files are ready, so a failed write is retryable.
      if (await stopWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline) !== "stopped") throw new Error("Legacy Windows registration disappeared before migration")
    } else {
      if (owner === "supervised" && !effects.supervisorStatus) throw new Error("Windows supervisor status is unavailable")
      const status = await withinServiceDeadline(deadline, async () => effects.supervisorStatus?.(assertHome(target.home), deadline))
      if (status?.treeUnconfirmed) throw new Error(windowsTreeUnknown)
      if (status?.supervising || status?.running) throw new Error("The Windows supervisor is still active; stop and remove it before installing again")
      // Stopped/exhausted history does not disable its logon registration.
      // Fence and drain the old task before a replacement configuration is visible.
      if (owner === "supervised" || effects.readConfiguration?.(assertHome(target.home), "win32") !== undefined) {
        if (!effects.stopSupervisor) throw new Error("Windows supervisor evidence is missing; replacement refused")
        const removal = windowsTaskRemovalPlan(displayName)
        let previousTask: { action: WindowsTaskAction; command: string; runtime: ServiceRuntimeRecord | undefined } | undefined
        if (owner === "supervised") {
          const action = await readWindowsTaskAction(displayName, effects, deadline)
          const runtime = effects.readConfiguration?.(assertHome(target.home), "win32")?.serviceRuntime
          const command = action === "missing" ? undefined : domovoiTaskCommand(action, plan.configuration.path, runtime)
          if (action === "missing" || !command || !action.arguments.includes('" --service-supervise "')) throw new Error("Windows supervisor registration changed before reinstall")
          previousTask = { action, command, runtime }
        }
        await disableWindowsTask(removal, effects, deadline)
        await withinServiceDeadline(deadline, () => effects.stopSupervisor!(plan.configuration.path, deadline, {
          retire: false,
          stopTask: async () => {
            // Tree evidence is already proved under the startup lease. A task
            // deleted outside Domovoi has no registration left to drain.
            const stopped = await stopWindowsTask(removal, effects, deadline)
            return stopped === "stopped" || stopped === "missing"
          },
          ...(owner === "supervised" ? { confirmNoLaunch: () => windowsTaskDisabledAndIdle(displayName, effects, deadline) } : {}),
        }))
        if (previousTask) {
          const previous = previousTask
          // Retirement is now cleared and no old instance remains. Rollback
          // restores the logon registration only, never issues a demand start.
          restoreSupervisedWindows = async () => {
            const current = await readWindowsTaskAction(displayName, effects, deadline)
            if (current !== "missing" && domovoiTaskCommand(current, plan.configuration.path, previous.runtime) !== previous.command) {
              throw new Error("Windows task action changed during reinstall; restoration refused")
            }
            if (current === "missing") {
              const create = plan.commands.find((command) => command.args[0] === "/create")
              if (!create) throw new Error("Windows task registration command is unavailable")
              const args = create.args.map((arg, index) => create.args[index - 1] === "/tr" ? previous.command : arg)
              await withinServiceDeadline(deadline, () => effects.run(create.command, args, deadline))
              const settings = windowsTaskSettingsCommand(displayName)
              await withinServiceDeadline(deadline, () => effects.run(settings.command, settings.args, deadline))
            }
            await withinServiceDeadline(deadline, () => effects.run(windowsSchtasksPath(),
              ["/change", "/tn", displayName, previous.action.enabled ? "/enable" : "/disable"], deadline))
          }
        }
      }
    }
  }
  let configurationRestored = true
  try {
    const commands = [...await launchdCommandsBeforeInstall(target, plan, effects, deadline), ...plan.commands]
    const previousFiles = await readPreviousFiles(plan, effects, deadline)
    const leases: ProfileLease[] = []
    try {
      // A profile an earlier registration named is not the in-app daemon's, so
      // it is claimed before the handoff.
      if (previous && !sameProfileDirectory(previous, profile, target.platform)) leases.push(effects.claimProfile(previous))
      // The handoff (ruled 2026-09-23, option B; placed by security review
      // rounds 1 and 2 on #574): the service-operation lease is held, the plan
      // is built, the saved registration is read, and the profile is free or
      // held by an in-app daemon, so every check that can refuse has passed.
      // The caller's in-app daemon lets the profile go only now, once, and
      // before the profile is claimed for the service.
      let released = false
      if (handoff) {
        checkProfileBeforeHandoff(profile, effects)
        await withinServiceDeadline(deadline, handoff)
        deadline.throwIfExpired()
        released = true
      }
      try {
        leases.push(effects.claimProfile(profile))
      } catch (cause) {
        // Another daemon took the profile between the check and this claim.
        if (released && cause instanceof ProfileAlreadyOwnedError) throw new DaemonServiceHandoffError(cause)
        throw cause
      }
      // Every check that can refuse has passed: the profile checks, the
      // handoff's own check, the caller's fence inside the handoff, and this
      // claim. The caller's staged runtime goes into place only now, under the
      // lease, before the first file is written (security review rounds 4 and 5
      // of #577).
      if (beforeChanges !== undefined) await withinServiceDeadline(deadline, beforeChanges)
      await withinServiceDeadline(deadline, () => effects.remove(localOwnerRemovalReceiptPath(profile), deadline))
      // Decided 2026-09-17 (SHIP-PLAN S1.1): a systemd user unit gets lingering,
      // turned on before service.json is written, so the one write records
      // whether Domovoi turned it on (linger.ts).
      if (target.platform === "linux" && plan.kind === "file") plan = await withLinger(target, plan, effects, deadline)
      const written = plan
      try {
        configurationRestored = false
        await withinServiceDeadline(deadline, () => effects.write(written.configuration.path, written.configuration.contents, deadline))
        if (written.kind === "file") await withinServiceDeadline(deadline, () => effects.write(written.path, written.contents, deadline))
      } catch (cause) {
        // Security review round 4 (#574): no manager has seen the new files, so
        // both go back to what they were, under the profile lease. A timed-out
        // write may still land, so then nothing is put back.
        if (previousFiles && !deadline.signal.aborted) {
          await putPreviousFilesBack(previousFiles, effects, deadline, cause)
          configurationRestored = true
          if (written.linger?.kind === "enabled") await lingerAfterRestore(target, effects, deadline, cause)
        }
        throw cause
      }
      deadline.throwIfExpired()
    } finally {
      // Timed-out filesystem work may still settle. Retain the lease until this
      // CLI process exits in that case. Otherwise the saved service config now
      // prevents Desktop fallback, so release before asking the manager to start.
      if (!deadline.signal.aborted) for (const lease of leases) lease.release()
    }
    const registering = commands.findIndex(registersDefinition)
    let bootoutSent = false
    let legacyWindowsRemoved = false
    for (const [index, { command, args }] of commands.entries()) {
      try {
        if (command === "launchctl" && args[0] === "bootout") bootoutSent = true
        if (legacyWindowsCommand && index === registering) {
          if (await removeWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline, true, words) !== "removed") throw new Error("Legacy Windows registration disappeared before migration")
          legacyWindowsRemoved = true
        }
        await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
      } catch (cause) {
        // Security review round 3 (#574): the manager kept what it ran before,
        // so the files go back to what they were and still name it. A timed-out
        // command may still register late, so then nothing is put back.
        if (index <= registering && previousFiles && !deadline.signal.aborted) {
          await putPreviousFilesBack(previousFiles, effects, deadline, cause)
          configurationRestored = true
          if (legacyWindowsCommand && legacyWindowsRemoved && index === registering) {
            // Preserve the old action for a retry if /create failed after deletion.
            // Do not restart it: legacy descendants have no job-object evidence.
            const restoreArgs = args.map((arg, position) => args[position - 1] === "/tr" ? legacyWindowsCommand! : arg)
            await withinServiceDeadline(deadline, () => effects.run(command, restoreArgs, deadline))
            await disableWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline)
          }
          if (bootoutSent) await loadPreviousAgent(target, plan, previousFiles, effects, deadline, cause)
          if (plan.linger?.kind === "enabled") await lingerAfterRestore(target, effects, deadline, cause)
        }
        throw cause
      }
    }
    return plan
  } catch (cause) {
    // A late write or registration may still settle after deadline expiry.
    // Failed file rollback must not re-enable a task on replacement inputs.
    if (restoreSupervisedWindows && configurationRestored && !deadline.signal.aborted) {
      try { await restoreSupervisedWindows() }
      catch (restoreCause) {
        const detail = (error: unknown) => error instanceof Error ? error.message : String(error)
        throw new AggregateError([cause, restoreCause], `${detail(cause)}. Restoring the previous Windows task also failed: ${detail(restoreCause)}`, { cause: restoreCause })
      }
    }
    throw cause
  }
}

// Lingering for the installing user, and the plan whose service.json records
// what was done. An earlier install's record is read first so a reinstall
// keeps a lingering Domovoi turned on as Domovoi's; one that cannot be read
// counts as no record.
async function withLinger(target: ServiceTarget, plan: ServicePlan, effects: InstallEffects, deadline: OperationDeadline): Promise<InstalledService> {
  let previous: boolean | undefined
  try {
    previous = effects.readConfiguration?.(target.configuration.homeDirectory, target.platform)?.lingerEnabledByDomovoi
  } catch {
    previous = undefined
  }
  const linger = await enableLinger(target, previous, effects, deadline)
  const { lingerEnabledByDomovoi: _earlier, ...configuration } = parseServiceConfiguration(plan.configuration.contents)
  const record = lingerRecord(linger)
  const contents = serializeServiceConfiguration(record === undefined ? configuration : { ...configuration, lingerEnabledByDomovoi: record })
  return { ...plan, configuration: { ...plan.configuration, contents }, linger }
}

export function installService(
  target: ServiceTarget,
  effects: InstallEffects & Pick<ServiceEffects, "claimServiceOperation">,
  options: { handoff?: () => Promise<void>; callerProfile?: ProfileLocation; beforeChanges?: () => Promise<void>; words?: ServiceCommandWords } = {},
): Promise<InstalledService> {
  return serviceOperation(effects, (deadline) => installWithDeadline(target, effects, deadline, options.words ?? domovoidServiceWords, options.handoff, options.callerProfile, options.beforeChanges))
}

// Security review rounds 1 and 2 (#574): any program can register a Windows
// task under Domovoi's task name. Status and removal, from the desktop and the
// CLI alike (ruled 2026-09-25), report or change the task only once it is
// Domovoi's: service.json holds a Domovoi registration, and the task runs a
// runtime on an entry with --service-config and that file's path, in the
// shape servicePlan writes. The runtime and entry must be exactly the ones
// service.json records (serviceRuntime), compared as written. An install from
// before that record was written stays removable only under a narrow rule:
// `domovoid service install` ran process.execPath (node.exe) on process.argv[1],
// the daemon entry of an npm or pnpm install (@getdomovoi\daemon\dist\index.js)
// or of a checkout (apps\daemon\dist\index.js). No other program passes.

// Text ruled 2026-09-25.
export class WindowsTaskNotDomovoiError extends Error {
  constructor(readonly taskName: string) {
    super(`A Windows task named "${taskName}" exists, but Domovoi did not register it. Nothing was stopped or deleted.`)
    this.name = "WindowsTaskNotDomovoiError"
  }
}

function plainWindowsPath(path: string | undefined): boolean {
  return path !== undefined
    && /^[A-Za-z]:\\/.test(path)
    && !hasForbiddenCharacter(path)
    && !path.includes("\x7f")
    && win32.normalize(path) === path
}

const legacyDaemonEntry = /\\(?:@getdomovoi|apps)\\daemon\\dist\\index\.js$/i

export function isDomovoiTaskAction(action: Pick<WindowsTaskAction, "path" | "arguments">, configurationPath: string, recorded: ServiceRuntimeRecord | undefined): boolean {
  // Task Scheduler may report the program with the quotes schtasks was given.
  const program = /^"([^"]*)"$/.exec(action.path)?.[1] ?? action.path
  const quoted = /^"([^"]*)" (--service-config|--service-supervise) "([^"]*)"$/.exec(action.arguments)
  if (!quoted) return false
  const [, entry = "", , saved = ""] = quoted
  if (saved !== configurationPath || !plainWindowsPath(program) || !plainWindowsPath(entry)) return false
  if (recorded) return program === recorded.executable && entry === recorded.entry
  return win32.basename(program).toLowerCase() === "node.exe" && legacyDaemonEntry.test(entry)
}

async function windowsTaskOwner(
  home: string,
  effects: Pick<ServiceEffects, "capture" | "readConfiguration">,
  deadline: OperationDeadline,
): Promise<"missing" | "domovoi" | "supervised" | "other"> {
  const action = await readWindowsTaskAction(displayName, effects, deadline)
  if (action === "missing") return "missing"
  if (!effects.readConfiguration) throw new Error("checking who registered the Windows task needs the saved service configuration")
  const saved = effects.readConfiguration(home, "win32")
  if (saved === undefined || !isDomovoiTaskAction(action, serviceConfigurationPath(home, "win32"), saved.serviceRuntime)) return "other"
  return action.arguments.includes('" --service-supervise "') ? "supervised" : "domovoi"
}

export type ServiceUpdateEffects = Pick<ServiceEffects, "write" | "read" | "run" | "capture" | "exists" | "claimProfile" | "claimServiceOperation" | "readOwner" | "stopSupervisor">

export type ServiceUpdateWaits = {
  // How long a stopped service's daemon has to let the profile go.
  profileWaitMs: number
  // How long a started service has to report ready.
  readinessWaitMs: number
  // The budget of the swap, and separately of the restore.
  budgetMs: number
}

// The command a Domovoi logon task runs, as servicePlan writes it, rebuilt
// from the task's action; undefined for an action of any other shape, or one
// that runs anything but the runtime and entry service.json records, which is
// never registered again (security review rounds 2 and 3). Task Scheduler may
// report the program with the quotes schtasks was given, so one pair is
// dropped.
function domovoiTaskCommand(action: WindowsTaskAction, configurationPath: string, recorded: ServiceRuntimeRecord | undefined): string | undefined {
  const execPath = /^"([^"]*)"$/.exec(action.path)?.[1] ?? action.path
  const quoted = /^"([^"]*)" (--service-config|--service-supervise) "([^"]*)"$/.exec(action.arguments)
  if (!quoted) return undefined
  const [, entry = "", flag = "", saved = ""] = quoted
  if (flag !== "--service-config" && flag !== "--service-supervise") return undefined
  const program = { execPath, args: [entry, flag, saved] }
  if (!isRecordedServiceProgram(program, { paths: "win32", flag, configurationPath }, recorded)) return undefined
  // Security review round 5: a failed step registers this command again, so
  // it must pass the refusals an install applies to a new one. A recorded
  // path with %, $( or a form Windows would not report refuses the update
  // before anything changes.
  try {
    for (const path of [execPath, entry, configurationPath]) refuseWindowsTaskPath(path)
  } catch (cause) {
    throw new DaemonServiceUpdateError("nothing-changed", cause)
  }
  return `"${execPath}" "${entry}" ${flag} "${configurationPath}"`
}

// The install's refusals for one Windows task path (security review rounds
// 1 to 3 on #574), for a path that did not come through servicePlan.
function refuseWindowsTaskPath(path: string): void {
  refuseTaskSchedulerExpansion(path)
  if (!plainWindowsPath(path)) throw new WindowsTaskPathError(path)
}

// Ruled 2026-09-23: an update swaps the installed service to a new runtime in
// place. The saved service configuration is kept as it is; the service
// definition changes. What the service ran before is read first, so any
// failed step, a timeout included, puts it back. A start counts only once the
// daemon reports ready, after the swap and after a restore alike. The caller
// runs this under the service-operation lease (runServiceUpdate), with effects
// tracked by trackInFlight.
// beforeWrite: runs once every step that can refuse with nothing changed has
// passed, right before the new definition is written (security review rounds
// 4 and 5 of #577: the caller's staged runtime goes into place there). It is
// given the swap's deadline. Round 10: on systemd it is not raced with that
// deadline; it settles on its own and says what happened to the copy.
export function prepareServiceUpdate(target: ServiceTarget, effects: ServiceUpdateEffects, waits: ServiceUpdateWaits, inFlight: InFlight, beforeWrite?: (deadline: OperationDeadline) => Promise<void>) {
  return async (readDeadline: OperationDeadline): Promise<ServiceSwap<ServicePlan>> => {
    const plan = servicePlan(target)
    const profile = profileLocation(target.configuration.homeDirectory, target.configuration.profileDirectory)
    const registrationId = target.configuration.registrationId
    // Ruled 2026-09-24 (A): the runtime service.json records is the only one a
    // failed step may start again. The swap records the new runtime with the
    // new definition (plan.configuration); the restore puts both back.
    const recorded = target.configuration.serviceRuntime
    const previousConfiguration = serializeServiceConfiguration(target.configuration)
    const readOwner = effects.readOwner
    if (!readOwner) throw new Error("the update needs to read the daemon's owner record")
    const runIn = (deadline: OperationDeadline) => (command: ServiceCommand) => withinServiceDeadline(deadline, () => effects.run(command.command, command.args, deadline))
    const writeIn = (deadline: OperationDeadline) => (path: string, contents: string) => withinServiceDeadline(deadline, () => effects.write(path, contents, deadline))
    // Every instance seen, from the one running now on; none of them can
    // count as a new start.
    const instances = new OwnerInstances(readOwner, profile)
    await instances.note(readDeadline)
    // Starts a service definition and waits for its daemon to report ready.
    const startIn = (deadline: OperationDeadline) => async (commands: readonly ServiceCommand[], afterCommand?: (command: ServiceCommand) => void) => {
      await instances.note(deadline)
      for (const command of commands) {
        await runIn(deadline)(command)
        afterCommand?.(command)
      }
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
      // Put back on a failed step, so it must be a Domovoi service file that
      // runs exactly the runtime service.json records. Security review rounds
      // 2 and 3: anything else is not Domovoi's service, and is said to be
      // changed outside Domovoi (ruled 2026-09-24).
      const program = (target.platform === "linux" ? systemdUnitProgram : launchdPlistProgram)(previous)
      if (!program || !isRecordedServiceProgram(program, { paths: "posix", flag: "--service-config", configurationPath: plan.configuration.path }, recorded)) {
        throw new DaemonServiceUpdateError("changed-outside")
      }
      // Security review round 6: a failed step starts the old unit again, so
      // its runtime and entry must pass the refusals an install applies.
      if (target.platform === "linux") {
        try {
          for (const path of [program.execPath, program.args[0] ?? ""]) refuseSystemdPath(path)
        } catch (cause) {
          throw new DaemonServiceUpdateError("nothing-changed", cause)
        }
      }

      if (target.platform === "linux") {
        // The running daemon holds the profile across its own restart, so the
        // profile is not claimed here, for the unit or for service.json.
        const reload = { command: "systemctl", args: ["--user", "daemon-reload"] }
        const restart = { command: "systemctl", args: ["--user", "restart", unitFile] }
        return {
          swap: async (deadline) => {
            if (beforeWrite !== undefined) {
              try {
                // Round 10 (P2): not raced with the deadline. The hook settles
                // on its own and says what happened to the copy (publishFirst).
                await beforeWrite(deadline)
              } catch (cause) {
                // The unit is untouched. A publish that fails writes only a
                // fresh directory no service uses; one that completed says
                // so itself (runtime-copied).
                if (cause instanceof DaemonServiceUpdateError) throw cause
                throw new DaemonServiceUpdateError("nothing-changed", cause)
              }
            }
            try {
              await writeIn(deadline)(plan.path, plan.contents)
            } catch (cause) {
              // The unit is replaced by rename, so a write that failed on its
              // own left the old one. A write the deadline cut short may still
              // rename the new unit into place: that is a failed swap, and the
              // restore runs once the write has settled. After a publish the
              // runtime did change, so it is a failed swap too.
              if (deadline.signal.aborted || beforeWrite !== undefined) throw cause
              throw new DaemonServiceUpdateError("nothing-changed", cause)
            }
            await writeIn(deadline)(plan.configuration.path, plan.configuration.contents)
            await runIn(deadline)(reload)
            await startIn(deadline)([restart])
            return plan
          },
          restore: async (deadline) => {
            await writeIn(deadline)(plan.path, previous)
            await writeIn(deadline)(plan.configuration.path, previousConfiguration)
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
      // Security review round 5: the plist the loaded job came from, or
      // undefined when none is loaded. launchd binds the label to whichever
      // plist was bootstrapped, so a job from another plist is never booted
      // out, by the swap or by the restore.
      const loadedFrom = async (deadline: OperationDeadline) => {
        const printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", job], deadline))
        if (printed.code === 113 && isMissingServiceFailure("darwin", printed)) return undefined
        if (printed.code !== 0) throw captureFailure("launchctl", printed)
        return launchdJobPath(printed.stdout)
      }
      const bootoutIn = (deadline: OperationDeadline) => async () => {
        const from = await loadedFrom(deadline)
        if (from === undefined) return
        if (from !== plan.path) throw new DaemonServiceUpdateError("nothing-changed", new LaunchdJobNotDomovoiError(from))
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
            if (beforeWrite !== undefined) await withinServiceDeadline(deadline, () => beforeWrite(deadline))
            wroteNew = true
            await writeIn(deadline)(plan.path, plan.contents)
            await writeIn(deadline)(plan.configuration.path, plan.configuration.contents)
          })
          await startIn(deadline)([bootstrap])
          return plan
        },
        restore: async (deadline) => {
          const from = await loadedFrom(deadline)
          if (from !== undefined && from !== plan.path) throw new LaunchdJobNotDomovoiError(from)
          if (from !== undefined) await runIn(deadline)(bootout)
          if (wroteNew) {
            await writeIn(deadline)(plan.path, previous)
            await writeIn(deadline)(plan.configuration.path, previousConfiguration)
          }
          await startIn(deadline)([bootstrap])
        },
      }
    }

    // The Windows logon task: stopped (and disabled) through Task Scheduler,
    // the profile held while it lets go and service.json records the new
    // runtime, then registered again with the new command, which enables it,
    // and run.
    const previous = await readWindowsTaskAction(displayName, effects, readDeadline)
    if (previous === "missing") throw new DaemonServiceUpdateError("not-installed")
    const previousCommand = domovoiTaskCommand(previous, plan.configuration.path, recorded)
    if (previousCommand === undefined) throw new DaemonServiceUpdateError("changed-outside")
    const restoreCommands = plan.commands.map((command) => command.args[0] !== "/create" ? command : {
      ...command,
      args: command.args.map((arg, index) => command.args[index - 1] === "/tr" ? previousCommand : arg),
    })
    const legacy = !previous.arguments.includes('" --service-supervise "')
    let legacyRemoved = false
    let newRegistrationSucceeded = false
    if (!effects.stopSupervisor) throw new DaemonServiceUpdateError("nothing-changed", new Error("Windows supervisor shutdown proof is unavailable"))
    const stopTask = async (deadline: OperationDeadline, restoring = false) => {
      const removal = windowsTaskRemovalPlan(displayName)
      if (legacy && !newRegistrationSucceeded) {
        const removed = await removeWindowsTask(removal, effects, deadline, true)
        if (removed === "removed") legacyRemoved = true
        else if (!restoring || !legacyRemoved) throw new Error("Legacy Windows registration disappeared before migration")
        return
      }
      await disableWindowsTask(removal, effects, deadline)
      await withinServiceDeadline(deadline, () => effects.stopSupervisor!(plan.configuration.path, deadline, { retire: false,
        stopTask: async () => await stopWindowsTask(removal, effects, deadline) === "stopped",
        confirmNoLaunch: () => windowsTaskDisabledAndIdle(displayName, effects, deadline),
        ...(restoring ? { previousConfigurationDigest: createHash("sha256").update(serializeServiceConfiguration(parseServiceConfiguration(previousConfiguration))).digest("hex") } : {}) }))
    }
    const stoppedInstance = currentInstance(readOwner, profile)
    let wroteNew = false
    return {
      swap: async (deadline) => {
        try {
          await stopTask(deadline)
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
        await whileHeldIn(deadline, stoppedInstance)(async () => {
          // Round 6 (P1): under the profile lease, before service.json names
          // the new runtime and the task is registered to run it.
          if (beforeWrite !== undefined) await withinServiceDeadline(deadline, () => beforeWrite(deadline))
          wroteNew = true
          await writeIn(deadline)(plan.configuration.path, plan.configuration.contents)
        })
        await startIn(deadline)(plan.commands, (command) => {
          if (command.args[0] === "/create") newRegistrationSucceeded = true
        })
        return plan
      },
      restore: async (deadline) => {
        // Whatever instance the swap left running is stopped first: Task
        // Scheduler ignores a run while one runs, and a late start of the new
        // runtime must not pass for the previous service.
        await stopTask(deadline, true)
        if (wroteNew) await writeIn(deadline)(plan.configuration.path, previousConfiguration)
        await startIn(deadline)(restoreCommands)
      },
    }
  }
}

// A service that was never installed is not an error to remove: the end state
// the caller asked for is the one they get either way.
type RemovalEffects = Pick<ServiceEffects, "run" | "capture" | "remove" | "exists" | "claimProfile" | "removalSnapshot" | "writeRemovalReceipt" | "claimServiceOperation" | "readConfiguration" | "readOwner" | "stopSupervisor" | "supervisorStatus">
type ServiceRemovalResult = ServiceRemovalPlan & {
  profileRecovery: "recorded" | "operator-confirmation-required" | "proof-unavailable" | "not-needed"
  profileRecoveryDetail?: string
  // Linux: what happened to lingering, when service.json recorded it.
  linger?: LingerRemovalOutcome
}

// Only a failure raised while the Task Scheduler adapter holds the deadline is
// a task removal failure. Refusals before it (exclusion, SystemRoot) and after
// it (profile ownership) never touched the task and keep their own message.
type RemovalProgress = { managerHoldsDeadline: boolean }

async function removeWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid" | "user">,
  effects: RemovalEffects,
  deadline: OperationDeadline,
  progress: RemovalProgress,
  profileReleaseWaitMs: number,
  words: ServiceCommandWords,
  callerProfile?: ProfileLocation,
): Promise<ServiceRemovalResult> {
  const plan = serviceRemovalPlan(target)
  const home = assertHome(target.home)
  deadline.throwIfExpired()
  // Read before anything is stopped, so a task Domovoi did not register is
  // left running and registered.
  const windowsOwner = plan.kind === "task" ? await windowsTaskOwner(home, effects, deadline) : undefined
  if (windowsOwner === "other") throw new WindowsTaskNotDomovoiError(displayName)
  if (windowsOwner === "missing" && !effects.readConfiguration?.(home, "win32")) {
    const evidence = await withinServiceDeadline(deadline, async () => effects.supervisorStatus?.(home, deadline))
    if (evidence?.treeUnconfirmed || evidence?.supervising || evidence?.running) throw new Error(evidence.detail)
  }
  // Decided 2026-09-17 (SHIP-PLAN S1.1): read before anything changes. Only a
  // record that Domovoi turned lingering on turns it off; a configuration that
  // cannot be read names no record, and lingering is left as found.
  let lingerEnabledByDomovoi: boolean | undefined
  if (target.platform === "linux" && plan.kind === "file") {
    try {
      lingerEnabledByDomovoi = effects.readConfiguration?.(home, target.platform)?.lingerEnabledByDomovoi
    } catch {
      lingerEnabledByDomovoi = undefined
    }
  }
  const before = effects.removalSnapshot(home, target.platform)
  // Security review rounds 2 and 3 of #577: the caller's profile is checked
  // against this snapshot, the one read of service.json the removal acts on,
  // under the service-operation lease and before any manager action.
  if (callerProfile !== undefined) {
    if (before.configurationUnknown !== undefined) {
      throw new ServiceProfileUnknownError(`${before.configurationUnknown} The profile the login service runs is not known.`)
    }
    if (before.configurationDigest === null) {
      const registered = await registeredServiceWithoutConfiguration(target, plan, effects, deadline)
      if (registered !== undefined) throw registeredWithoutConfiguration(registered)
    } else {
      // Round 4 (P1): the profile the saved configuration names under its
      // own home, as the service runs it.
      if (before.effectiveProfileDirectory === undefined) {
        throw new ServiceProfileUnknownError("The saved service configuration names no profile. The profile the login service runs is not known.")
      }
      assertServiceProfile({ profileDirectory: before.effectiveProfileDirectory }, callerProfile, target.platform)
    }
  }
  let managerStopped = true
  if (plan.kind === "task") {
    // A missing task can still have a live supervisor and tree. Configuration
    // presence keeps the proof obligation even after external task deletion.
    if (windowsOwner === "supervised" || (windowsOwner === "missing" && effects.readConfiguration?.(home, "win32") !== undefined)) {
      if (!effects.stopSupervisor) throw new Error("Windows supervisor shutdown proof is unavailable; task and configuration retained")
      progress.managerHoldsDeadline = true
      try {
        await disableWindowsTask(plan, effects, deadline)
        await withinServiceDeadline(deadline, () => effects.stopSupervisor!(serviceConfigurationPath(home, "win32"), deadline,
          windowsOwner === "supervised" ? { confirmNoLaunch: () => windowsTaskDisabledAndIdle(plan.name, effects, deadline) } : undefined))
      } catch (cause) { throw new WindowsTaskRemovalError(plan.name, cause, { stopIssued: true, words }) }
    }
    progress.managerHoldsDeadline = true
    managerStopped = await removeWindowsTask(plan, effects, deadline, windowsOwner === "domovoi", words) === "removed"
    progress.managerHoldsDeadline = false
  }
  // Security review round 2 (#574): with no Domovoi service file, the same-
  // named job is not Domovoi's to stop; on launchd, neither is a job loaded
  // from another plist. Either counts as a manager that stopped nothing.
  const servicePath = plan.kind === "file" ? plan.path : undefined
  let ownsJob = servicePath !== undefined && await withinServiceDeadline(deadline, () => effects.exists(servicePath, deadline))
  if (ownsJob && target.platform === "darwin") {
    const printed = await withinServiceDeadline(deadline, () => effects.capture("launchctl", ["print", `gui/${assertUid(target.uid)}/${agentLabel}`], deadline))
    if (printed.code === 0) ownsJob = launchdJobPath(printed.stdout) === servicePath
    else if (printed.code === 113 && isMissingServiceFailure("darwin", printed)) ownsJob = false
    else throw captureFailure("launchctl", printed)
  }
  if (plan.kind === "file" && !ownsJob) managerStopped = false
  // Round 5 of #577 (P2): lease, and write any recovery receipt into, the
  // profile the saved configuration names under its own home.
  const profile = profileLocation(home, before.effectiveProfileDirectory ?? before.profileDirectory)
  const readOwner = effects.readOwner ?? (() => undefined)
  const stoppedInstance = target.platform === "darwin" && ownsJob ? currentInstance(readOwner, profile) : undefined
  for (const { command, args } of plan.kind === "file" && ownsJob ? plan.commands : []) {
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
  // Bootout returns before the daemon lets the profile go, found by the packaged smoke (#742).
  const lease = target.platform === "darwin" && ownsJob && managerStopped
    ? await claimProfileAfterStop(effects.claimProfile, readOwner, profile, stoppedInstance, profileReleaseWaitMs, deadline,
      `The service was stopped, but its daemon did not let the profile go within ${seconds(profileReleaseWaitMs)}. The launch agent file and saved configuration were kept. Run ${words.remove} again once that daemon has exited.`)
    : effects.claimProfile(profile)
  let removed: ServiceRemovalResult
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
    removed = {
      ...plan,
      profileRecovery: recovery.kind === "receipt" ? "recorded" : recovery.kind,
      ...(recovery.kind === "proof-unavailable" ? { profileRecoveryDetail: recovery.reason } : {}),
    }
  } finally {
    // A late config deletion must not outlive the lease and erase a successor's
    // launch settings. On expiry the CLI retains it until process exit.
    if (!deadline.signal.aborted) lease.release()
  }
  // Last, once the service is gone: a failure here is reported, never thrown,
  // and leaves lingering on.
  if (lingerEnabledByDomovoi === undefined) return removed
  return { ...removed, linger: lingerEnabledByDomovoi ? await disableLinger(target, effects, deadline) : { kind: "left-on" } }
}

export function removeService(
  target: Pick<ServiceTarget, "platform" | "home" | "uid" | "user">,
  effects: RemovalEffects,
  options: { callerProfile?: ProfileLocation; profileReleaseWaitMs?: number; words?: ServiceCommandWords } = {},
): Promise<ServiceRemovalResult> {
  const progress: RemovalProgress = { managerHoldsDeadline: false }
  const words = options.words ?? domovoidServiceWords
  return serviceOperation(effects, (deadline) => removeWithDeadline(target, effects, deadline, progress, options.profileReleaseWaitMs ?? 10_000, words, options.callerProfile)).catch((cause: unknown) => {
    // The outer deadline can expire before the manager adapter settles. It
    // needs the same actionable task-specific error, not a bare timer failure.
    if (progress.managerHoldsDeadline && !(cause instanceof WindowsTaskRemovalError)) {
      throw new WindowsTaskRemovalError(displayName, cause, { words })
    }
    throw cause
  })
}

async function statusWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists" | "supervisorStatus" | "readConfiguration">,
  deadline: OperationDeadline,
): Promise<ServiceStatus> {
  if (target.platform === "linux") {
    const supervisor = await withinServiceDeadline(deadline, async () => effects.supervisorStatus?.(assertHome(target.home), deadline))
    if (supervisor !== undefined) return supervisor
    const path = unitPath(target.home)
    const installed = await withinServiceDeadline(deadline, () => effects.exists(path, deadline))
    // Security review round 2 (#574): with no Domovoi unit file, a unit of
    // the same name is not Domovoi's to report. With the file present, the
    // name is Domovoi's: ~/.config/systemd/user outranks every other
    // persistent unit directory, and a transient unit cannot take a name
    // that has a unit file.
    if (!installed) return { installed, running: false, detail: `no service file at ${path}` }
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
    // Security review round 2 (#574): with no Domovoi plist, a job under the
    // label is not Domovoi's to report.
    if (!installed) return { installed, running: false, detail: `no launch agent at ${path}` }
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
      // A job loaded from another plist is not this agent: it is not loaded.
      if (launchdJobPath(printed.stdout) !== path) state = undefined
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
    const home = assertHome(target.home)
    const owner = await windowsTaskOwner(home, effects, deadline)
    if (owner === "other") return { installed: false, running: false, detail: `a task named ${displayName} exists, but Domovoi did not register it` }
    const state = await readWindowsTaskState(displayName, effects, deadline)
    const installed = state !== "missing"
    if (owner === "domovoi") return { installed, running: state === "4", detail: "legacy Windows logon task; no crash supervision or job-object tree evidence" }
    if (!effects.supervisorStatus) {
      if (!installed) return { installed: false, running: false, detail: `no logon task named ${displayName}` }
      throw new Error("Windows supervisor status is unavailable")
    }
    const supervisor = await withinServiceDeadline(deadline, () => effects.supervisorStatus!(home, deadline))
    if (!supervisor) return { installed, running: false, detail: installed ? "Windows supervisor has no recorded start; tree evidence unavailable" : `no logon task named ${displayName}`,
      ...(installed ? { supervisionFailure: "observation-failure" as const } : {}) }
    return { ...supervisor, installed, detail: `${installed ? "logon task registered" : "logon task missing"}; ${supervisor.detail}` }
  }

  throw new Error(`${target.platform} has no service manager this knows how to report on`)
}

export function serviceStatus(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists" | "claimServiceOperation" | "supervisorStatus" | "readConfiguration">,
): Promise<ServiceStatus> {
  return serviceOperation({
    claimServiceOperation: () => effects.claimServiceOperation("status"),
  }, (deadline) => statusWithDeadline(target, effects, deadline))
}

export type ServiceCommandWords = { install: string; status: string; remove: string; profileRecover: string }

export const domovoidServiceWords: ServiceCommandWords = {
  install: "domovoid service install",
  status: "domovoid service status",
  remove: "domovoid service remove",
  profileRecover: "domovoid profile recover --confirm-no-supervisor",
}

export type ServiceCommandDependencies = ServiceEffects & {
  words?: ServiceCommandWords
  platform: string
  execPath: string
  runtime?: string
  home?: string
  uid?: number
  user?: string
  environment?: DaemonEnvironment
  workingDirectory?: string
  // This daemon's version, which names the runtime copy an install from an
  // app's runtime makes (bundled-runtime.ts). Tests also pass where that copy
  // is staged and the file system it is made with.
  version?: string
  runtimeStagingParent?: string
  runtimeFileSystem?: RuntimeFileSystem
  // What reads the service definition for the removal of unused copies; by
  // default the app's reader (desktop-service.ts).
  runtimeReader?: DaemonServiceRuntimeReader
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
  const words = dependencies.words ?? domovoidServiceWords
  const verb = args[1]
  if (args.length > 2 || verb === undefined || !["install", "status", "remove"].includes(verb)) {
    dependencies.stderr(`Usage: ${words.install}\n       ${words.status}\n       ${words.remove}\n`)
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
    const configuration = verb === "install"
      ? createServiceConfiguration(dependencies.environment ?? {}, {
        platform: dependencies.platform,
        homeDirectory: assertHome(dependencies.home),
        workingDirectory: dependencies.workingDirectory ?? process.cwd(),
      })
      : undefined
    // Q408 A: from an app's runtime, the service runs a copy under the
    // profile, published under the service-operation lease. Inside WSL too:
    // the Windows task starts the guest runtime, and the app's path goes away
    // once an AppImage unmounts or the app moves.
    const bundled = configuration === undefined ? undefined : await bundledServiceRuntime({
      execPath: dependencies.execPath,
      platform: dependencies.platform,
      environment: dependencies.environment ?? {},
      profileDirectory: configuration.profileDirectory ?? profileDirectory(configuration.homeDirectory, dependencies.platform),
      version: dependencies.version,
      home: configuration.homeDirectory,
      ...(dependencies.runtimeFileSystem === undefined ? {} : { fileSystem: dependencies.runtimeFileSystem }),
      ...(dependencies.runtimeStagingParent === undefined ? {} : { stagingParent: dependencies.runtimeStagingParent }),
      claimServiceOperation: dependencies.claimServiceOperation,
      ...(dependencies.runtimeReader === undefined ? {} : { reader: dependencies.runtimeReader }),
    })
    if (dependencies.platform === "linux" && (savedWsl || installingFromWsl)) {
      const guest = bundled === undefined
        ? dependencies
        : { ...dependencies, execPath: bundled.runtime.daemonEntryPath, runtime: bundled.runtime.nodePath }
      const publish = bundled === undefined ? undefined : async () => {
        await bundled.publish()
        dependencies.stdout(`Copied the daemon runtime out of the app to ${bundled.copy}, so the service does not run from inside the app.\n`)
      }
      return await serviceOperation(dependencies, (deadline) => runWslServiceCommand(verb, guest, deadline, publish))
    }
    if (configuration !== undefined) {
      const plan = bundled === undefined
        ? await installService({ ...target, configuration }, dependencies, { words })
        : await installService({ ...target, execPath: bundled.runtime.daemonEntryPath, runtime: bundled.runtime.nodePath, configuration }, dependencies, { beforeChanges: bundled.publish, words })
      if (bundled !== undefined) {
        dependencies.stdout(`Copied the daemon runtime out of the app to ${bundled.copy}, so the service does not run from inside the app.\n`)
        // #635: the app's Install removes unused copies once it has reached
        // the running service. The command does not attach to it; it runs
        // the cleanup once the service manager has accepted every command
        // that registers and starts the service, and the cleanup itself
        // reads the definition again and keeps the copy it names. A WSL
        // guest service has no definition this can read, so its copies are
        // kept (runtime-cleanup.ts).
        await bundled.removeUnused()
      }
      dependencies.stdout(
        plan.kind === "file"
          ? `Installed the Domovoi daemon service at ${plan.path}\n`
          : `Installed the Domovoi daemon service as ${serviceName}\n`,
      )
      if (plan.linger !== undefined) {
        const line = lingerInstallLine(plan.linger, target, words)
        dependencies[line.stream](line.text)
      }
      return 0
    }

    if (verb === "remove") {
      const plan = await removeService(target, dependencies, { words })
      dependencies.stdout(
        plan.kind === "file"
          ? `Removed the Domovoi daemon service at ${plan.path}\n`
          : `Removed the Domovoi daemon service ${displayName}\n`,
      )
      if (plan.linger !== undefined) {
        const line = lingerRemovalLine(plan.linger, target)
        dependencies[line.stream](line.text)
      }
      if (plan.profileRecovery === "operator-confirmation-required") {
        dependencies.stdout(`The profile owner remains unresolved. After confirming no custom or legacy supervisor will restart it, run ${words.profileRecover}.\n`)
      }
      if (plan.profileRecovery === "proof-unavailable") {
        dependencies.stdout(`${plan.profileRecoveryDetail}. No recovery receipt was written. Repair or inspect that file, then after confirming no custom or legacy supervisor will restart the daemon, run ${words.profileRecover}.\n`)
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
    return status.installed && status.supervisionFailure === undefined ? 0 : 1
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// Review F3: a Windows tool named by its drive path (schtasks.exe and
// PowerShell under SystemRoot) runs from its own directory, not the caller's,
// which may be a repository. A bare name keeps the caller's directory: the
// Linux and macOS managers resolve through PATH, which is trusted.
function managerDirectory(command: string): { cwd?: string } {
  return /^[A-Za-z]:\\/.test(command) ? { cwd: win32.dirname(command) } : {}
}

export function nodeServiceEffects(options: { userHomeDirectory?: string } = {}): ServiceEffects {
  // Manager names are per OS user, not per caller-selected HOME or profile.
  // One effect keeps status reads and mutations on the same lease when a
  // fixture overrides the claim to isolate the operator's service lock.
  function claimOperation(): FileLease
  function claimOperation(access: "status"): FileLease | undefined
  function claimOperation(access?: "status"): FileLease | undefined {
    const home = options.userHomeDirectory ?? userInfo().homedir
    return access === "status" ? claimServiceStatusRead(home) : claimServiceOperation(home)
  }

  return {
    readConfiguration: (home, platform) => {
      try { return parseServiceConfiguration(readLocalProfileFile(serviceConfigurationPath(home, platform), 64 * 1024)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    },
    stopSupervisor: process.platform === "win32" ? stopWindowsSupervisor : (path, deadline) => stopGuestSupervisor(path, deadline),
    claimServiceOperation: claimOperation,
    claimProfile,
    registeredProfile: (home, platform) => {
      let text: string
      try { text = readLocalProfileFile(serviceConfigurationPath(home, platform), 64 * 1024) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
      const saved = parseServiceConfiguration(text)
      return profileLocation(saved.homeDirectory, saved.profileDirectory, platform)
    },
    removalSnapshot: readServiceRemovalSnapshot,
    writeRemovalReceipt: writeLocalOwnerRemovalReceipt,
    supervisorStatus: async (home, deadline) => process.platform === "win32" ? readWindowsSupervisorStatus(home, deadline) : readGuestSupervisorStatus(home),
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
        execFile(command, args, { ...managerDirectory(command), signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()), killSignal: "SIGKILL" }, (error) => (error ? reject(error) : resolve()))
      })
    },
    capture: async (command, args, deadline) => {
      const { execFile } = await import("node:child_process")
      deadline.throwIfExpired()
      return new Promise<CapturedRun>((resolve) => {
        execFile(command, args, { ...managerDirectory(command), signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()), killSignal: "SIGKILL" }, (error, stdout, stderr) => {
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
