import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"

import type { OperationDeadline } from "../operation-deadline.js"
import { profileLocation } from "../profile-directory.js"
import { localOwnerRemovalReceiptPath } from "../local-owner-removal.js"
import { z } from "zod"

import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceCommand, ServiceCommandDependencies, ServiceEffects } from "./install.js"
import { claimProfileAfterStop, currentInstance, DaemonServiceUpdateError, waitUntilReady, type ServiceSwap } from "./update-outcome.js"
import { serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { installedWslTask, type WslInstallation } from "./wsl-registration.js"
import { removeWindowsTask, type WindowsTaskRemovalPlan } from "./windows-task.js"

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

const wslUpdateIntentSchema = z.object({
  version: z.literal(1),
  previous: z.string().min(1),
  next: z.string().min(1),
}).strict()

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
      const text = await withinServiceDeadline(readDeadline, () => read(intentPath, readDeadline))
      const parsed: unknown = JSON.parse(text)
      const intent = wslUpdateIntentSchema.parse(parsed)
      previous = parseServiceConfiguration(intent.previous)
      interrupted = parseServiceConfiguration(intent.next)
    }
    if (!previous.wsl || !previous.registrationId) throw new Error("No saved WSL service registration; no systemd action was attempted")
    const registrationId = previous.registrationId
    const old = installedWslTask(previous.wsl, registrationId, path)
    const updated = { ...previous, wsl: { ...previous.wsl, executable: runtime.nodePath, args: [runtime.daemonEntryPath] } }
    const next = installedWslTask(updated.wsl, registrationId, path)
    const candidates = [old.removal, next.removal,
      ...(interrupted?.wsl ? [installedWslTask(interrupted.wsl, registrationId, path).removal] : [])]
    const profile = profileLocation(previous.homeDirectory, previous.profileDirectory)
    const stoppedInstance = currentInstance(readOwner, profile)
    const intent = `${JSON.stringify({ version: 1, previous: serializeServiceConfiguration(previous), next: serializeServiceConfiguration(updated) })}\n`

    const confirmedIn = (deadline: OperationDeadline) => async (command: ServiceCommand) => {
      const result = await withinServiceDeadline(deadline, () => effects.capture(command.command, command.args, deadline))
      if (result.code !== 0) throw new Error(result.stderr?.trim() || `Task Scheduler command exited with code ${result.code}`)
      return result.stdout.trim()
    }
    const startIn = (deadline: OperationDeadline) => async (task: typeof old) => {
      const before = currentInstance(readOwner, profile)
      if (await confirmedIn(deadline)(task.register) !== "domovoi-task:created") throw new Error("WSL task registration was not confirmed")
      if (!/^domovoi-task:[1-4]$/.test(await confirmedIn(deadline)(task.start))) throw new Error("WSL task start was not confirmed")
      await waitUntilReady(readOwner, profile, registrationId, before, waits.readinessWaitMs, deadline)
    }
    const writeIn = (deadline: OperationDeadline) => (file: string, contents: string) => withinServiceDeadline(deadline, () => effects.write(file, contents, deadline))
    const removeIntentIn = (deadline: OperationDeadline) => () => withinServiceDeadline(deadline, () => effects.remove(intentPath, deadline))

    return {
      swap: async (deadline) => {
        try {
          await writeIn(deadline)(intentPath, intent)
        } catch (cause) {
          throw new DaemonServiceUpdateError("nothing-changed", cause)
        }
        if (interrupted === undefined) {
          if (!/^domovoi-task:(missing|[1-4])$/.test(await confirmedIn(deadline)(old.disable))) throw new Error("WSL task disable was not confirmed")
        }
        await withinServiceDeadline(deadline, () => stopSupervisor(path, deadline))
        if (interrupted === undefined) await removeWindowsTask(old.removal, effects, deadline)
        else await removeRegisteredTask(candidates, effects, deadline)
        const lease = await claimProfileAfterStop(effects.claimProfile, readOwner, profile, stoppedInstance, waits.profileWaitMs, deadline)
        try {
          await writeIn(deadline)(path, serializeServiceConfiguration(updated))
        } finally {
          lease.release()
        }
        await startIn(deadline)(next)
        await removeIntentIn(deadline)()
        return { name: next.name, configurationPath: path }
      },
      restore: async (deadline) => {
        await removeRegisteredTask(candidates, effects, deadline)
        await writeIn(deadline)(path, serializeServiceConfiguration(previous))
        await startIn(deadline)(old)
        await removeIntentIn(deadline)()
      },
    }
  }
}

export async function runWslServiceCommand(verb: string, dependencies: ServiceCommandDependencies, deadline: OperationDeadline): Promise<number> {
  const home = dependencies.home
  if (!home || !posix.isAbsolute(home)) throw new Error("WSL service requires an absolute guest home")
  const path = serviceConfigurationPath(home, "linux")
  const saved = dependencies.readConfiguration?.(home, "linux")
  if (verb === "install") {
    if (saved) throw new Error("Remove the existing service registration before installing the WSL service")
    if (await withinServiceDeadline(deadline, () => dependencies.exists(posix.join(home, ".config/systemd/user/domovoid.service"), deadline))) {
      throw new Error("Remove the existing systemd registration before installing the WSL service")
    }
    const wsl = await discover(dependencies, deadline)
    const configuration = { ...createServiceConfiguration(dependencies.environment ?? {}, {
      platform: "linux", homeDirectory: home, workingDirectory: dependencies.workingDirectory ?? process.cwd(),
    }), registrationId: randomUUID(), wsl }
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
  const disabled = await capture(task.disable, dependencies, deadline)
  if (!/^domovoi-task:(missing|[1-4])$/.test(disabled)) throw new Error("WSL task disable was not confirmed")
  if (!dependencies.stopSupervisor) throw new Error("WSL guest shutdown proof is unavailable")
  await withinServiceDeadline(deadline, () => dependencies.stopSupervisor!(path, deadline))
  const removed = await removeWindowsTask(task.removal, dependencies, deadline)
  deadline.throwIfExpired()
  const profile = profileLocation(home, saved.profileDirectory)
  const lease = dependencies.claimProfile(profile)
  try {
    const recovery = serviceRemovalRecovery(before, dependencies.removalSnapshot(home, "linux"), removed === "removed")
    await withinServiceDeadline(deadline, () => dependencies.remove(path, deadline))
    if (recovery.kind === "receipt") dependencies.writeRemovalReceipt(profile, lease, serviceRemovalReceipt(recovery, "win32"), deadline)
    dependencies.stdout(`Removed the Domovoi WSL service ${task.name}; profile recovery: ${recovery.kind}. Guest profile data retained.\n`)
  } finally { if (!deadline.signal.aborted) lease.release() }
  return 0
}
