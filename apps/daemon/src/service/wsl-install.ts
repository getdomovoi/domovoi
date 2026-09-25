import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"
import { isDeepStrictEqual } from "node:util"

import type { OperationDeadline } from "../operation-deadline.js"
import { profileLocation } from "../profile-directory.js"
import { localOwnerRemovalReceiptPath } from "../local-owner-removal.js"
import { z } from "zod"

import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration, type ServiceRuntimeRecord } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceCommand, ServiceCommandDependencies, ServiceEffects } from "./install.js"
import { claimProfileAfterStop, currentInstance, DaemonServiceUpdateError, OwnerInstances, releaseWhenSettled, type InFlight, type ServiceSwap } from "./update-outcome.js"
import { hasDomovoiServiceShape, isRecordedServiceProgram } from "./restore-target.js"
import { serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { installedWslTask, type WslInstallation } from "./wsl-registration.js"
import { removeWindowsTask, WindowsTaskRemovalError, type WindowsTaskRemovalPlan } from "./windows-task.js"

async function capture(command: ServiceCommand, dependencies: ServiceCommandDependencies, deadline: OperationDeadline) {
  const result = await withinServiceDeadline(deadline, () => dependencies.capture(command.command, command.args, deadline))
  if (result.code !== 0) throw new Error("WSL service command failed; registration and profile are retained")
  if (Buffer.byteLength(result.stdout) > 16_384) throw new Error("WSL service response exceeded its bound")
  return result.stdout.trim()
}

async function discover(dependencies: ServiceCommandDependencies, deadline: OperationDeadline): Promise<WslInstallation> {
  const environment = dependencies.environment ?? {}
  if (!environment.WSL_INTEROP || !environment.WSL_DISTRO_NAME) throw new Error("WSL service installation requires WSL 2 Windows interop")
  const candidate = environment.DOMOVOI_WINDOWS_POWERSHELL ?? await capture({
    command: "/usr/bin/wslpath", args: ["-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  }, dependencies, deadline)
  if (!posix.isAbsolute(candidate) || candidate.length > 4096
    || [...candidate].some((character) => character < " " || character === "\x7f")) {
    throw new Error("WindowsPowerShell requires a bounded absolute guest path")
  }
  const powershell = posix.normalize(candidate)
  await capture({ command: "/usr/bin/test", args: ["-f", powershell] }, dependencies, deadline)
  const root = await capture({ command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write($env:SystemRoot)"] }, dependencies, deadline)
  if (!/^[A-Za-z]:[\\/]/.test(root) || [...root].some((character) => character < " " || character === "\x7f")) {
    throw new Error("Windows did not report an absolute SystemRoot")
  }
  const translated = await capture({ command: "/usr/bin/wslpath", args: ["-u", win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] }, dependencies, deadline)
  if (posix.normalize(translated) !== powershell) throw new Error("WindowsPowerShell path does not match Windows SystemRoot")
  if (!dependencies.user || !dependencies.home) throw new Error("WSL service requires the installing guest user and home")
  return {
    distribution: environment.WSL_DISTRO_NAME, linuxUser: dependencies.user, powershell,
    wsl: win32.join(root, "System32", "wsl.exe"),
    executable: dependencies.runtime ?? dependencies.execPath,
    args: dependencies.runtime === undefined ? [] : [dependencies.execPath],
  }
}

export type WslServiceUpdateEffects = Pick<ServiceEffects, "write" | "read" | "exists" | "remove" | "capture" | "claimProfile" | "stopSupervisor" | "readOwner">

// Written before the old task is deleted and removed once the update ends
// either way. Between the delete and the new registration there is no task;
// if the update stops there (a timeout, or the desktop quitting), the next
// update finds this record and starts from the configuration named here as
// previous, whatever service.json says by then.
export function wslUpdateIntentPath(configurationPath: string): string {
  return `${configurationPath}.update-intent.json`
}

// `completed` is written only once the update has ended with that side's
// service reporting ready, and only when removing the record failed.
const wslUpdateIntentSchema = z.object({
  version: z.literal(1),
  previous: z.string().min(1),
  next: z.string().min(1),
  completed: z.enum(["previous", "next"]).optional(),
}).strict()

type WslUpdateIntent = { previous: ServiceConfiguration; next: ServiceConfiguration; completed?: "previous" | "next" }

function wslUpdateIntentText(previous: ServiceConfiguration, next: ServiceConfiguration, completed?: "previous" | "next"): string {
  return `${JSON.stringify({ version: 1, previous: serializeServiceConfiguration(previous), next: serializeServiceConfiguration(next), ...(completed === undefined ? {} : { completed }) })}\n`
}

// The configuration as it is saved and read back, so two can be compared
// whatever order their fields were built in. The runtime record is left out:
// it names the runtime that last reported ready, which an update changes on
// its own, and is checked against what is started instead.
function asSaved(configuration: ServiceConfiguration): ServiceConfiguration {
  const { serviceRuntime: _record, ...settings } = parseServiceConfiguration(serializeServiceConfiguration(configuration))
  return settings
}

// The program the guest task runs for a saved runtime, as installedWslTask
// builds it.
function guestProgram(wsl: WslInstallation, configurationPath: string) {
  return { execPath: wsl.executable, args: [...wsl.args, "--service-supervise", configurationPath] }
}

const guestShape = (configurationPath: string) => ({ paths: "posix", flag: "--service-supervise", configurationPath }) as const

// Checked as every restore target is (security review round 2): the runtime,
// one daemon entry, and the supervise flag with this configuration.
function domovoiGuestRuntime(wsl: WslInstallation, configurationPath: string): boolean {
  return hasDomovoiServiceShape(guestProgram(wsl, configurationPath), guestShape(configurationPath))
}

// Security review round 3, ruled 2026-09-24 (A): a guest runtime a failed step
// registers and starts again must be exactly the one service.json records.
function recordedGuestRuntime(wsl: WslInstallation, configurationPath: string, recorded: ServiceRuntimeRecord | undefined): boolean {
  return isRecordedServiceProgram(guestProgram(wsl, configurationPath), guestShape(configurationPath), recorded)
}

// An update changes only the guest runtime, and writes it in the shape an
// install does: an absolute normalized executable and one absolute normalized
// daemon entry. A recorded configuration that differs from the saved one in
// anything else (registration, profile, distribution, user, PowerShell or
// wsl.exe), or names a runtime of another shape, was not written by an update
// of this service, and nothing it names is registered or started.
function recordedByThisService(recorded: ServiceConfiguration, saved: ServiceConfiguration): boolean {
  if (!recorded.wsl || !saved.wsl) return false
  if (!domovoiGuestRuntime(recorded.wsl, serviceConfigurationPath(saved.homeDirectory, "linux"))) return false
  return isDeepStrictEqual(asSaved({ ...recorded, wsl: { ...recorded.wsl, executable: saved.wsl.executable, args: saved.wsl.args } }), asSaved(saved))
}

// Ruled 2026-09-23: a damaged record has one fixed cause, never a parser's
// own words. A record that cannot be read as a private regular file, or that
// does not match the saved registration, is damaged too.
async function readWslUpdateIntent(
  intentPath: string,
  read: (path: string, deadline: OperationDeadline) => Promise<string>,
  saved: ServiceConfiguration | undefined,
  deadline: OperationDeadline,
): Promise<WslUpdateIntent> {
  try {
    const text = await withinServiceDeadline(deadline, () => read(intentPath, deadline))
    const parsed: unknown = JSON.parse(text)
    const intent = wslUpdateIntentSchema.parse(parsed)
    const recorded = {
      previous: parseServiceConfiguration(intent.previous),
      next: parseServiceConfiguration(intent.next),
      ...(intent.completed === undefined ? {} : { completed: intent.completed }),
    }
    if (!saved || !recordedByThisService(recorded.previous, saved) || !recordedByThisService(recorded.next, saved)) {
      throw new Error("The update record does not match the saved service registration")
    }
    return recorded
  } catch (cause) {
    if (deadline.signal.aborted) throw cause
    throw new Error("the record of an interrupted update is unreadable", { cause })
  }
}

// A record marked completed, whose completed side is the configuration saved
// now, belongs to an update that ended with that service reporting ready:
// only removing the record failed. An unmarked record is an interrupted
// update even when service.json already names its next configuration, since
// the swap saves that before the new task has reported ready.
function finishedUpdate(recorded: WslUpdateIntent, saved: ServiceConfiguration | undefined): boolean {
  return recorded.completed !== undefined && saved !== undefined
    && isDeepStrictEqual(asSaved(recorded[recorded.completed]), asSaved(saved))
}

// Ruled 2026-09-23: inside an update, the old task's removal failing is named
// in a few words; the removal command keeps its own, longer advice.
function oldTaskNotRemoved(error: unknown): Error {
  const underlying = error instanceof WindowsTaskRemovalError && error.cause !== undefined ? error.cause : error
  const detail = (underlying instanceof Error ? underlying.message : String(underlying)).trim().replace(/\.+$/u, "")
  return new Error(`the old Windows task could not be removed: ${detail}`, { cause: error })
}

// Removes whichever of these tasks is registered under the shared name. Each
// task's checks refuse another task's action before changing anything, so a
// refusal moves on to the next candidate.
async function removeRegisteredTask(plans: readonly WindowsTaskRemovalPlan[], effects: Pick<ServiceEffects, "capture">, deadline: OperationDeadline): Promise<void> {
  let failure: unknown
  for (const plan of plans) {
    try {
      await removeWindowsTask(plan, effects, deadline)
      return
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

// Ruled 2026-09-23 (B): a WSL guest service is updated in place too. Its
// Windows task runs the guest runtime by name, and Task Scheduler checks that
// action on every step, so the old task is retired (disabled, its guest
// supervisor stopped and proved stopped, then deleted), the new runtime is
// saved with the profile held, and a task for it is registered and started
// and must report ready. Any failed step puts the old task and its saved
// runtime back, starts it and waits for it to report ready.
export function prepareWslUpdate(
  saved: ServiceConfiguration,
  runtime: { nodePath: string; daemonEntryPath: string },
  effects: WslServiceUpdateEffects,
  waits: { profileWaitMs: number; readinessWaitMs: number },
  inFlight: InFlight,
) {
  return async (readDeadline: OperationDeadline): Promise<ServiceSwap<{ name: string; configurationPath: string }>> => {
    const path = serviceConfigurationPath(saved.homeDirectory, "linux")
    const intentPath = wslUpdateIntentPath(path)
    const stopSupervisor = effects.stopSupervisor
    if (!stopSupervisor) throw new Error("WSL guest shutdown proof is unavailable")
    const readOwner = effects.readOwner
    if (!readOwner) throw new Error("the update needs to read the daemon's owner record")
    const read = effects.read
    if (!read) throw new Error("the update needs to read the saved service configuration")
    // An update that stopped between deleting the old task and registering
    // the new one left a record of where it started.
    let interrupted: ServiceConfiguration | undefined
    let previous = saved
    if (await withinServiceDeadline(readDeadline, () => effects.exists(intentPath, readDeadline))) {
      const recorded = await readWslUpdateIntent(intentPath, read, saved, readDeadline)
      // A finished update whose record could not be removed leaves nothing to
      // roll back; this update writes its own record over it.
      if (!finishedUpdate(recorded, saved)) {
        previous = recorded.previous
        interrupted = recorded.next
      }
    }
    if (!previous.wsl || !previous.registrationId) throw new Error("No saved WSL service registration; no systemd action was attempted")
    // The old task is registered and started again on a failed step, so the
    // runtime it runs must be exactly the one service.json records (security
    // review rounds 2 and 3, ruled 2026-09-24 A), whether it comes from
    // service.json or from the record of an interrupted update. A crafted
    // intent record of any other kind was refused above with its own cause.
    const recorded = saved.serviceRuntime
    if (!recorded || !recordedGuestRuntime(previous.wsl, path, recorded)) throw new DaemonServiceUpdateError("changed-outside")
    const registrationId = previous.registrationId
    const old = installedWslTask(previous.wsl, registrationId, path)
    // service.json keeps naming the previous runtime as the one that last
    // reported ready until the new one has; an update interrupted before then
    // still starts from it.
    const restored = { ...previous, serviceRuntime: recorded }
    const updated = { ...restored, wsl: { ...previous.wsl, executable: runtime.nodePath, args: [runtime.daemonEntryPath] } }
    const ready = { ...updated, serviceRuntime: { executable: runtime.nodePath, entry: runtime.daemonEntryPath } }
    const next = installedWslTask(updated.wsl, registrationId, path)
    const candidates = [old.removal, next.removal,
      ...(interrupted?.wsl ? [installedWslTask(interrupted.wsl, registrationId, path).removal] : [])]
    const profile = profileLocation(previous.homeDirectory, previous.profileDirectory)
    const stoppedInstance = currentInstance(readOwner, profile)
    const instances = new OwnerInstances(readOwner, profile)
    await instances.note(readDeadline)
    const intent = wslUpdateIntentText(previous, updated)

    const confirmedIn = (deadline: OperationDeadline) => async (command: ServiceCommand) => {
      const result = await withinServiceDeadline(deadline, () => effects.capture(command.command, command.args, deadline))
      if (result.code !== 0) throw new Error(result.stderr?.trim() || `Task Scheduler command exited with code ${result.code}`)
      return result.stdout.trim()
    }
    const startIn = (deadline: OperationDeadline) => async (task: typeof old) => {
      await instances.note(deadline)
      if (await confirmedIn(deadline)(task.register) !== "domovoi-task:created") throw new Error("WSL task registration was not confirmed")
      if (!/^domovoi-task:[1-4]$/.test(await confirmedIn(deadline)(task.start))) throw new Error("WSL task start was not confirmed")
      await instances.waitUntilReady(registrationId, waits.readinessWaitMs, deadline)
    }
    const writeIn = (deadline: OperationDeadline) => (file: string, contents: string) => withinServiceDeadline(deadline, () => effects.write(file, contents, deadline))
    const removeIntentIn = (deadline: OperationDeadline) => () => withinServiceDeadline(deadline, () => effects.remove(intentPath, deadline))
    // Ends the update once the given side's service has reported ready. A
    // record that cannot be removed is marked with that side instead, so the
    // next update or status clears it rather than rolling back. If neither
    // works, the record stays unmarked and the next update restores from its
    // previous configuration, a service that ran before.
    const settleIntentIn = (deadline: OperationDeadline) => async (running: "previous" | "next") => {
      try {
        await removeIntentIn(deadline)()
      } catch {
        await writeIn(deadline)(intentPath, wslUpdateIntentText(previous, updated, running)).catch(() => undefined)
      }
    }

    return {
      swap: async (deadline) => {
        if (interrupted === undefined) {
          if (!/^domovoi-task:(missing|[1-4])$/.test(await confirmedIn(deadline)(old.disable))) throw new Error("WSL task disable was not confirmed")
        }
        await withinServiceDeadline(deadline, () => stopSupervisor(path, deadline))
        // Written just before the delete, once the old task is disabled and
        // its guest supervisor stopped, so status never reports an
        // interrupted update while the old task still runs.
        await writeIn(deadline)(intentPath, intent)
        try {
          if (interrupted === undefined) await removeWindowsTask(old.removal, effects, deadline)
          else await removeRegisteredTask(candidates, effects, deadline)
        } catch (error) {
          throw oldTaskNotRemoved(error)
        }
        const lease = await claimProfileAfterStop(effects.claimProfile, readOwner, profile, stoppedInstance, waits.profileWaitMs, deadline)
        try {
          await writeIn(deadline)(path, serializeServiceConfiguration(updated))
        } finally {
          await releaseWhenSettled(lease, inFlight)
        }
        await startIn(deadline)(next)
        // The new service has reported ready; only now is the update done,
        // and service.json records its runtime. The new daemon holds the
        // profile, so this write, like the intent record's, is made without
        // it. If it fails, the record of the update is kept as it is: the
        // next update starts from the previous runtime service.json still
        // records.
        try {
          await writeIn(deadline)(path, serializeServiceConfiguration(ready))
        } catch {
          return { name: next.name, configurationPath: path }
        }
        await settleIntentIn(deadline)("next")
        return { name: next.name, configurationPath: path }
      },
      restore: async (deadline) => {
        await removeRegisteredTask(candidates, effects, deadline)
        await writeIn(deadline)(path, serializeServiceConfiguration(restored))
        await startIn(deadline)(old)
        // The previous service has reported ready, so the restore worked. A
        // record that cannot be removed is left for later cleanup, marked as
        // settled on the previous configuration; it does not undo the restore.
        await settleIntentIn(deadline)("previous")
      },
    }
  }
}

export async function runWslServiceCommand(verb: string, dependencies: ServiceCommandDependencies, deadline: OperationDeadline): Promise<number> {
  const home = dependencies.home
  if (!home || !posix.isAbsolute(home)) throw new Error("WSL service requires an absolute guest home")
  const path = serviceConfigurationPath(home, "linux")
  const intentPath = wslUpdateIntentPath(path)
  // Ruled 2026-09-23 (option A): an interrupted update is reported by status
  // and refused by install; the next update or a removal settles it.
  let interrupted = await withinServiceDeadline(deadline, () => dependencies.exists(intentPath, deadline))
  const saved = dependencies.readConfiguration?.(home, "linux")
  if (interrupted && verb === "status" && dependencies.read) {
    const recorded = await readWslUpdateIntent(intentPath, dependencies.read, saved, deadline).catch(() => undefined)
    if (recorded && finishedUpdate(recorded, saved)) {
      // A finished update whose record could not be removed: cleared here.
      await withinServiceDeadline(deadline, () => dependencies.remove(intentPath, deadline)).catch(() => undefined)
      interrupted = false
    }
  }
  if (interrupted && verb === "status") {
    dependencies.stdout("not installed; a service update was interrupted before the new Windows task was registered. Run Update the service from the app, or domovoid service remove, to settle it.\n")
    return 1
  }
  if (interrupted && verb === "install") {
    throw new Error("A service update was interrupted before the new Windows task was registered. Run Update the service from the app, or domovoid service remove, before installing.")
  }
  if (verb === "install") {
    if (saved) throw new Error("Remove the existing service registration before installing the WSL service")
    if (await withinServiceDeadline(deadline, () => dependencies.exists(posix.join(home, ".config/systemd/user/domovoid.service"), deadline))) {
      throw new Error("Remove the existing systemd registration before installing the WSL service")
    }
    const wsl = await discover(dependencies, deadline)
    // Ruled 2026-09-24 (A): the guest runtime and daemon entry installed are
    // recorded, so an update puts back only those. A guest install with no
    // separate entry has nothing an update could put back, and records nothing.
    const configuration = { ...createServiceConfiguration(dependencies.environment ?? {}, {
      platform: "linux", homeDirectory: home, workingDirectory: dependencies.workingDirectory ?? process.cwd(),
    }), registrationId: randomUUID(), wsl,
    ...(dependencies.runtime === undefined ? {} : { serviceRuntime: { executable: dependencies.runtime, entry: dependencies.execPath } }) }
    const task = installedWslTask(wsl, configuration.registrationId, path)
    const contents = serializeServiceConfiguration(configuration)
    const profile = profileLocation(home, configuration.profileDirectory)
    const lease = dependencies.claimProfile(profile)
    try {
      await withinServiceDeadline(deadline, () => dependencies.remove(localOwnerRemovalReceiptPath(profile), deadline))
      await withinServiceDeadline(deadline, () => dependencies.write(path, contents, deadline))
    } finally { if (!deadline.signal.aborted) lease.release() }
    for (const command of [task.register, task.start]) {
      await withinServiceDeadline(deadline, () => dependencies.run(command.command, command.args, deadline))
    }
    dependencies.stdout(`Installed the Domovoi WSL guest supervisor as ${task.name}. Windows user logon only; no boot supervision.\n`)
    return 0
  }
  if (!saved?.wsl || !saved.registrationId) throw new Error("No saved WSL service registration; no systemd action was attempted")
  if (saved.homeDirectory !== home) throw new Error("WSL service home differs from its saved registration")
  const task = installedWslTask(saved.wsl, saved.registrationId, path)
  if (verb === "status") {
    const state = await capture(task.inspect, dependencies, deadline)
    if (!/^domovoi-task:(missing|[1-4])$/.test(state)) throw new Error("WSL task returned an unknown state")
    const guest = await withinServiceDeadline(deadline, async () => dependencies.supervisorStatus?.(home))
    dependencies.stdout(`${state === "domovoi-task:missing" ? "not installed" : "installed"}; ${guest?.detail ?? "guest supervision unverified"}\n`)
    return state !== "domovoi-task:missing" && guest && guest.supervisionFailure === undefined ? 0 : 1
  }
  const before = dependencies.removalSnapshot(home, "linux")
  // After an interrupted update, the task under the shared name may run the
  // previous runtime, the new one, or be gone; each is tried in turn.
  const tasks = [task]
  if (interrupted && dependencies.read) {
    const read = dependencies.read
    const recorded = await readWslUpdateIntent(intentPath, read, saved, deadline).catch(() => undefined)
    for (const configuration of recorded ? [recorded.previous, recorded.next] : []) {
      if (configuration.wsl) tasks.push(installedWslTask(configuration.wsl, saved.registrationId, path))
    }
  }
  let disabled: string | undefined
  let refusal: unknown
  for (const candidate of tasks) {
    try {
      disabled = await capture(candidate.disable, dependencies, deadline)
      break
    } catch (error) {
      refusal = error
    }
  }
  if (disabled === undefined) throw refusal
  if (!/^domovoi-task:(missing|[1-4])$/.test(disabled)) throw new Error("WSL task disable was not confirmed")
  if (!dependencies.stopSupervisor) throw new Error("WSL guest shutdown proof is unavailable")
  await withinServiceDeadline(deadline, () => dependencies.stopSupervisor!(path, deadline))
  let removed: "removed" | "already-missing" | undefined
  for (const candidate of tasks) {
    try {
      removed = await removeWindowsTask(candidate.removal, dependencies, deadline)
      break
    } catch (error) {
      refusal = error
    }
  }
  if (removed === undefined) throw refusal
  deadline.throwIfExpired()
  const profile = profileLocation(home, saved.profileDirectory)
  const lease = dependencies.claimProfile(profile)
  try {
    const recovery = serviceRemovalRecovery(before, dependencies.removalSnapshot(home, "linux"), removed === "removed")
    await withinServiceDeadline(deadline, () => dependencies.remove(path, deadline))
    if (interrupted) await withinServiceDeadline(deadline, () => dependencies.remove(intentPath, deadline))
    if (recovery.kind === "receipt") dependencies.writeRemovalReceipt(profile, lease, serviceRemovalReceipt(recovery, "win32"), deadline)
    dependencies.stdout(`Removed the Domovoi WSL service ${task.name}; profile recovery: ${recovery.kind}. Guest profile data retained.\n`)
  } finally { if (!deadline.signal.aborted) lease.release() }
  return 0
}
