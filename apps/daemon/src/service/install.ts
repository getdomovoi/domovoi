import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, posix, win32 } from "node:path"
import { userInfo } from "node:os"
import { installedWslTask } from "./wsl-registration.js"
import { runWslServiceCommand } from "./wsl-install.js"
import { stopGuestSupervisor } from "./supervisor-command.js"

import type { DaemonEnvironment } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { claimProfile, ProfileAlreadyOwnedError, type ProfileLease } from "../profile-lease.js"
import { localOwnerRemovalReceiptPath, writeLocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { readServiceRemovalSnapshot, serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration, type ServiceRuntimeRecord } from "./configuration.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { withinServiceDeadline } from "./deadline.js"
import { claimServiceOperation } from "./operation-lease.js"
import { launchdPlist, launchdPlistProgram, systemdUnit, systemdUnitProgram } from "./units.js"
import { isRecordedServiceProgram } from "./restore-target.js"
import { readWindowsTaskAction, readWindowsTaskState, removeWindowsTask, stopWindowsTask, WindowsTaskRemovalError, windowsTaskRemovalPlan, type WindowsTaskAction, type WindowsTaskRemovalPlan } from "./windows-task.js"
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
  const serviceArgs = ["--service-config", configurationFile.path]
  const program = runtime === undefined ? execPath : runtime
  const args = runtime === undefined ? serviceArgs : [execPath, ...serviceArgs]
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
    const taskCommand = `${windowsTaskCommand(execPath, runtime)} --service-config "${assertExecutable(configurationFile.path, "the service configuration")}"`
    for (const path of [runtime, execPath, configurationFile.path]) {
      if (path !== undefined && !plainWindowsPath(path)) throw new WindowsTaskPathError(path)
    }
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

type InstallEffects = Pick<ServiceEffects, "write" | "read" | "run" | "capture" | "exists" | "claimProfile" | "remove" | "registeredProfile" | "readOwner" | "readConfiguration">

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
  if (printed.code === 0) return
  if (printed.code !== 113 || !isMissingServiceFailure("darwin", printed)) throw restoreFailure(cause, captureFailure("launchctl", printed))
  const path = plan.kind === "file" ? plan.path : undefined
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
  return (command === "schtasks" && args[0] === "/create")
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

async function installWithDeadline(
  target: ServiceTarget,
  effects: InstallEffects,
  deadline: OperationDeadline,
  handoff: (() => Promise<void>) | undefined,
): Promise<ServicePlan> {
  // Reinstalling is a new supervisor decision, not reuse of an old recovery
  // authorization. Assign the identity here, even if the caller supplied one.
  const plan = servicePlan({ ...target, configuration: { ...target.configuration, registrationId: randomUUID() } })
  deadline.throwIfExpired()
  const profile = profileLocation(target.configuration.homeDirectory, target.configuration.profileDirectory)
  const previous = effects.registeredProfile?.(target.configuration.homeDirectory, target.platform)
  // Security review round 3 (#574): schtasks /create /f replaces a task of
  // the same name, so a task Domovoi did not register refuses the install, by
  // the same check status and removal use, before anything changes.
  if (target.platform === "win32" && !target.configuration.wsl
    && await windowsTaskOwner(assertHome(target.home), effects, deadline) === "other") {
    throw new WindowsTaskNotDomovoiError(displayName)
  }
  const commands = [...await launchdCommandsBeforeInstall(target, plan, effects, deadline), ...plan.commands]
  const previousFiles = await readPreviousFiles(plan, effects, deadline)
  const leases: ProfileLease[] = []
  try {
    // A profile an earlier registration named is not the in-app daemon's, so
    // it is claimed before the handoff.
    if (previous && !sameProfileDirectory(previous, profile)) leases.push(effects.claimProfile(previous))
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
    await withinServiceDeadline(deadline, () => effects.remove(localOwnerRemovalReceiptPath(profile), deadline))
    try {
      await withinServiceDeadline(deadline, () => effects.write(plan.configuration.path, plan.configuration.contents, deadline))
      if (plan.kind === "file") await withinServiceDeadline(deadline, () => effects.write(plan.path, plan.contents, deadline))
    } catch (cause) {
      // Security review round 4 (#574): no manager has seen the new files, so
      // both go back to what they were, under the profile lease. A timed-out
      // write may still land, so then nothing is put back.
      if (previousFiles && !deadline.signal.aborted) await putPreviousFilesBack(previousFiles, effects, deadline, cause)
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
  for (const [index, { command, args }] of commands.entries()) {
    try {
      if (command === "launchctl" && args[0] === "bootout") bootoutSent = true
      await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
    } catch (cause) {
      // Security review round 3 (#574): the manager kept what it ran before,
      // so the files go back to what they were and still name it. A timed-out
      // command may still register late, so then nothing is put back.
      if (index <= registering && previousFiles && !deadline.signal.aborted) {
        await putPreviousFilesBack(previousFiles, effects, deadline, cause)
        if (bootoutSent) await loadPreviousAgent(target, plan, previousFiles, effects, deadline, cause)
      }
      throw cause
    }
  }
  return plan
}

export function installService(
  target: ServiceTarget,
  effects: InstallEffects & Pick<ServiceEffects, "claimServiceOperation">,
  options: { handoff?: () => Promise<void> } = {},
): Promise<ServicePlan> {
  return serviceOperation(effects, (deadline) => installWithDeadline(target, effects, deadline, options.handoff))
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

function isDomovoiTaskAction(action: WindowsTaskAction, configurationPath: string, recorded: ServiceRuntimeRecord | undefined): boolean {
  // Task Scheduler may report the program with the quotes schtasks was given.
  const program = /^"([^"]*)"$/.exec(action.path)?.[1] ?? action.path
  const quoted = /^"([^"]*)" --service-config "([^"]*)"$/.exec(action.arguments)
  if (!quoted) return false
  const [, entry = "", saved = ""] = quoted
  if (saved !== configurationPath || !plainWindowsPath(program) || !plainWindowsPath(entry)) return false
  if (recorded) return program === recorded.executable && entry === recorded.entry
  return win32.basename(program).toLowerCase() === "node.exe" && legacyDaemonEntry.test(entry)
}

async function windowsTaskOwner(
  home: string,
  effects: Pick<ServiceEffects, "capture" | "readConfiguration">,
  deadline: OperationDeadline,
): Promise<"missing" | "domovoi" | "other"> {
  const action = await readWindowsTaskAction(displayName, effects, deadline)
  if (action === "missing") return "missing"
  if (!effects.readConfiguration) throw new Error("checking who registered the Windows task needs the saved service configuration")
  const saved = effects.readConfiguration(home, "win32")
  return saved !== undefined && isDomovoiTaskAction(action, serviceConfigurationPath(home, "win32"), saved.serviceRuntime) ? "domovoi" : "other"
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

// The command a Domovoi logon task runs, as servicePlan writes it, rebuilt
// from the task's action; undefined for an action of any other shape, or one
// that runs anything but the runtime and entry service.json records, which is
// never registered again (security review rounds 2 and 3). Task Scheduler may
// report the program with the quotes schtasks was given, so one pair is
// dropped.
function domovoiTaskCommand(action: WindowsTaskAction, configurationPath: string, recorded: ServiceRuntimeRecord | undefined): string | undefined {
  const execPath = /^"([^"]*)"$/.exec(action.path)?.[1] ?? action.path
  const quoted = /^"([^"]*)" --service-config "([^"]*)"$/.exec(action.arguments)
  if (!quoted) return undefined
  const [, entry = "", saved = ""] = quoted
  const program = { execPath, args: [entry, "--service-config", saved] }
  if (!isRecordedServiceProgram(program, { paths: "win32", flag: "--service-config", configurationPath }, recorded)) return undefined
  // Security review round 5: a failed step registers this command again, so
  // it must pass the refusals an install applies to a new one. A recorded
  // path with %, $( or a form Windows would not report refuses the update
  // before anything changes.
  try {
    for (const path of [execPath, entry, configurationPath]) refuseWindowsTaskPath(path)
  } catch (cause) {
    throw new DaemonServiceUpdateError("nothing-changed", cause)
  }
  return `"${execPath}" "${entry}" --service-config "${configurationPath}"`
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
export function prepareServiceUpdate(target: ServiceTarget, effects: ServiceUpdateEffects, waits: ServiceUpdateWaits, inFlight: InFlight) {
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
    const stoppedInstance = currentInstance(readOwner, profile)
    let wroteNew = false
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
        await whileHeldIn(deadline, stoppedInstance)(async () => {
          wroteNew = true
          await writeIn(deadline)(plan.configuration.path, plan.configuration.contents)
        })
        await startIn(deadline)(plan.commands)
        return plan
      },
      restore: async (deadline) => {
        // Whatever instance the swap left running is stopped first: Task
        // Scheduler ignores a run while one runs, and a late start of the new
        // runtime must not pass for the previous service.
        await stopWindowsTask(windowsTaskRemovalPlan(displayName), effects, deadline)
        if (wroteNew) await writeIn(deadline)(plan.configuration.path, previousConfiguration)
        await startIn(deadline)(restoreCommands)
      },
    }
  }
}

// A service that was never installed is not an error to remove: the end state
// the caller asked for is the one they get either way.
type RemovalEffects = Pick<ServiceEffects, "run" | "capture" | "remove" | "exists" | "claimProfile" | "removalSnapshot" | "writeRemovalReceipt" | "claimServiceOperation" | "readConfiguration">
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
  // Read before anything is stopped, so a task Domovoi did not register is
  // left running and registered.
  if (plan.kind === "task" && await windowsTaskOwner(home, effects, deadline) === "other") {
    throw new WindowsTaskNotDomovoiError(displayName)
  }
  const before = effects.removalSnapshot(home, target.platform)
  let managerStopped = true
  if (plan.kind === "task") {
    progress.managerHoldsDeadline = true
    managerStopped = await removeWindowsTask(plan, effects, deadline) === "removed"
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
  effects: Pick<ServiceEffects, "capture" | "exists" | "supervisorStatus" | "readConfiguration">,
  deadline: OperationDeadline,
): Promise<ServiceStatus> {
  if (target.platform === "linux") {
    const supervisor = await withinServiceDeadline(deadline, async () => effects.supervisorStatus?.(assertHome(target.home)))
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
    if (await windowsTaskOwner(assertHome(target.home), effects, deadline) === "other") {
      // Text ruled 2026-09-25.
      return { installed: false, running: false, detail: `a task named ${displayName} exists, but Domovoi did not register it` }
    }
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
  effects: Pick<ServiceEffects, "capture" | "exists" | "claimServiceOperation" | "supervisorStatus" | "readConfiguration">,
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
