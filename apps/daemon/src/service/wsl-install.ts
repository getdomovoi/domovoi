import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"
import { loginServiceHomePaths } from "@getdomovoi/protocol"

import type { OperationDeadline } from "../operation-deadline.js"
import { profileLocation } from "../profile-directory.js"
import { localOwnerRemovalReceiptPath } from "../local-owner-removal.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceCommand, ServiceCommandDependencies } from "./install.js"
import { serviceRemovalReceipt, serviceRemovalRecovery } from "./removal-recovery.js"
import { refuseTaskSchedulerExpansion } from "./task-scheduler-expansion.js"
import { installedWslTask, type WslInstallation } from "./wsl-registration.js"
import { removeWindowsTask } from "./windows-task.js"

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

export async function runWslServiceCommand(verb: string, dependencies: ServiceCommandDependencies, deadline: OperationDeadline): Promise<number> {
  const home = dependencies.home
  if (!home || !posix.isAbsolute(home)) throw new Error("WSL service requires an absolute guest home")
  const path = serviceConfigurationPath(home, "linux")
  const saved = dependencies.readConfiguration?.(home, "linux")
  if (verb === "install") {
    if (saved) throw new Error("Remove the existing service registration before installing the WSL service")
    if (await withinServiceDeadline(deadline, () => dependencies.exists(posix.join(home, loginServiceHomePaths.linux), deadline))) {
      throw new Error("Remove the existing systemd registration before installing the WSL service")
    }
    const wsl = await discover(dependencies, deadline)
    // The task carries these in its wsl.exe path and arguments; refuse any
    // Task Scheduler would expand before a file is written or a task registered.
    for (const value of [wsl.wsl, wsl.distribution, wsl.linuxUser, wsl.executable, ...wsl.args, path]) refuseTaskSchedulerExpansion(value)
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
