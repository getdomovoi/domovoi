import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, posix } from "node:path"

import type { DaemonEnvironment } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { launchdPlist, systemdUnit } from "./units.js"

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
  write: (path: string, contents: string, deadline: OperationDeadline) => Promise<void>
  run: (command: string, args: string[], deadline: OperationDeadline) => Promise<void>
  capture: (command: string, args: string[], deadline: OperationDeadline) => Promise<CapturedRun>
  exists: (path: string, deadline: OperationDeadline) => Promise<boolean>
  remove: (path: string, deadline: OperationDeadline) => Promise<void>
}

export type ServiceStatus = {
  installed: boolean
  running: boolean
  detail: string
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
  // The configured home owns both the unit and daemon state. It cannot be
  // overridden by another field in the install target.
  if (home !== configuration.homeDirectory) throw new Error("The service configuration must belong to the installing user home")
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
}: Pick<ServiceTarget, "platform" | "home" | "uid">): ServiceRegistrationPlan {
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
    return {
      kind: "task",
      commands: [{ command: "schtasks", args: ["/delete", "/tn", displayName, "/f"] }],
    }
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
    await withinServiceDeadline(deadline, () => writeFile(staging, contents, { flag: "wx", mode: 0o600, signal: deadline.signal }))
    await withinServiceDeadline(deadline, () => rename(staging, path))
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

async function serviceOperation<T>(operation: (deadline: OperationDeadline) => Promise<T>): Promise<T> {
  const deadline = OperationDeadline.start(30_000)
  try {
    return await withinServiceDeadline(deadline, () => operation(deadline))
  } finally {
    deadline.clear()
  }
}

// The file is written before the service manager is asked to load it, and a
// write that fails stops the install rather than asking the manager to launch
// with a unit or configuration that is not there.
async function installWithDeadline(
  target: ServiceTarget,
  effects: Pick<ServiceEffects, "write" | "run">,
  deadline: OperationDeadline,
): Promise<ServicePlan> {
  const plan = servicePlan(target)
  await withinServiceDeadline(deadline, () => effects.write(plan.configuration.path, plan.configuration.contents, deadline))
  if (plan.kind === "file") await withinServiceDeadline(deadline, () => effects.write(plan.path, plan.contents, deadline))
  for (const { command, args } of plan.commands) await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
  return plan
}

export function installService(target: ServiceTarget, effects: Pick<ServiceEffects, "write" | "run">): Promise<ServicePlan> {
  return serviceOperation((deadline) => installWithDeadline(target, effects, deadline))
}

// A service that was never installed is not an error to remove: the end state
// the caller asked for is the one they get either way.
async function removeWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "run" | "remove" | "exists">,
  deadline: OperationDeadline,
): Promise<ServiceRegistrationPlan> {
  const plan = serviceRemovalPlan(target)
  for (const { command, args } of plan.commands) {
    try {
      await withinServiceDeadline(deadline, () => effects.run(command, args, deadline))
    } catch (error) {
      // A manager that refuses to stop a service it does not know about must
      // not keep the file from going away. Every other failure must preserve
      // the unit: deleting it while a live manager still owns the service
      // strands a process and falsely reports a successful removal.
      if (!isMissingServiceFailure(target.platform, error)) throw error
    }
  }
  const files = [
    ...(plan.kind === "file" ? [plan.path] : []),
    ...(target.home ? [serviceConfigurationPath(target.home, target.platform)] : []),
  ]
  for (const path of files) {
    if (await withinServiceDeadline(deadline, () => effects.exists(path, deadline))) {
      await withinServiceDeadline(deadline, () => effects.remove(path, deadline))
    }
  }
  return plan
}

export function removeService(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "run" | "remove" | "exists">,
): Promise<ServiceRegistrationPlan> {
  return serviceOperation((deadline) => removeWithDeadline(target, effects, deadline))
}

async function statusWithDeadline(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists">,
  deadline: OperationDeadline,
): Promise<ServiceStatus> {
  if (target.platform === "linux") {
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
    if (printed.code !== 0 && !isMissingServiceFailure("darwin", printed)) {
      throw captureFailure("launchctl", printed)
    }
    return {
      installed,
      running: printed.code === 0,
      detail: installed
        ? `${path} is ${printed.code === 0 ? "loaded" : "not loaded"}`
        : `no launch agent at ${path}`,
    }
  }

  if (target.platform === "win32") {
    const query = await withinServiceDeadline(deadline, () => effects.capture("schtasks", ["/query", "/tn", displayName, "/fo", "list"], deadline))
    if (query.code !== 0 && !isMissingServiceFailure("win32", query)) {
      throw captureFailure("schtasks", query)
    }
    const running = /status:\s*running/i.test(query.stdout)
    return {
      installed: query.code === 0,
      running,
      detail: query.code === 0
        ? `${displayName} is ${running ? "running" : "registered but not running"}`
        : `no logon task named ${displayName}`,
    }
  }

  throw new Error(`${target.platform} has no service manager this knows how to report on`)
}

export function serviceStatus(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists">,
): Promise<ServiceStatus> {
  return serviceOperation((deadline) => statusWithDeadline(target, effects, deadline))
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
      return 0
    }

    const status = await serviceStatus(target, dependencies)
    const installed = status.installed ? "installed" : "not installed"
    const running = status.running ? "running" : "not running"
    dependencies.stdout(`${installed}, ${running}: ${status.detail}\n`)
    return status.installed ? 0 : 1
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export function nodeServiceEffects(): ServiceEffects {
  return {
    write: writeUnit,
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
