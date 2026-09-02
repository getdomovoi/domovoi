import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { posix } from "node:path"

import { launchdPlist, systemdUnit, type ServiceEnvironment } from "./units.js"

const serviceName = "domovoid"
const unitFile = `${serviceName}.service`
const agentFile = "sh.domovoi.domovoid.plist"
const agentLabel = "sh.domovoi.domovoid"
const displayName = "Domovoi daemon"

export type ServiceCommand = { command: string; args: string[] }

export type ServicePlan =
  | { kind: "file"; path: string; contents: string; commands: ServiceCommand[] }
  | { kind: "task"; commands: ServiceCommand[] }

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
  environment?: ServiceEnvironment
}

export type CapturedRun = { code: number; stdout: string }

export type ServiceEffects = {
  write: (path: string, contents: string) => Promise<void>
  run: (command: string, args: string[]) => Promise<void>
  capture: (command: string, args: string[]) => Promise<CapturedRun>
  exists: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
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

function assertExecutable(execPath: string): string {
  if (!/^[A-Za-z]:\\/.test(execPath) || hasForbiddenCharacter(execPath)) {
    throw new Error(`${execPath} is not an absolute path to domovoid`)
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
  environment = {},
}: ServiceTarget): ServicePlan {
  if (platform === "linux") {
    return {
      kind: "file",
      path: unitPath(home),
      contents: systemdUnit({ execPath, environment }),
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", unitFile] },
      ],
    }
  }

  if (platform === "darwin") {
    const path = agentPath(home)
    return {
      kind: "file",
      path,
      contents: launchdPlist({ execPath, environment }),
      commands: [{ command: "launchctl", args: ["bootstrap", `gui/${assertUid(uid)}`, path] }],
    }
  }

  if (platform === "win32") {
    // A Windows service created with sc.exe runs as LocalSystem and belongs to
    // the machine, which is neither what the systemd user unit nor the launchd
    // agent does. A logon task runs as the user who asked, with their own
    // privileges, and needs no elevation to install.
    return {
      kind: "task",
      commands: [
        {
          command: "schtasks",
          args: [
            "/create",
            "/tn",
            displayName,
            "/tr",
            windowsTaskCommand(execPath, runtime),
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
}: Pick<ServiceTarget, "platform" | "home" | "uid">): ServicePlan {
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

async function writeUnit(path: string, contents: string): Promise<void> {
  // Every path a plan names is a posix one, because the only platforms that
  // get a file are the ones that use them.
  await mkdir(posix.dirname(path), { recursive: true })
  await writeFile(path, contents, { mode: 0o600 })
}

// The file is written before the service manager is asked to load it, and a
// write that fails stops the install rather than leaving a service pointing at
// a unit that is not there.
export async function installService(
  target: ServiceTarget,
  effects: Pick<ServiceEffects, "write" | "run">,
): Promise<ServicePlan> {
  const plan = servicePlan(target)
  if (plan.kind === "file") await effects.write(plan.path, plan.contents)
  for (const { command, args } of plan.commands) await effects.run(command, args)
  return plan
}

// A service that was never installed is not an error to remove: the end state
// the caller asked for is the one they get either way.
export async function removeService(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "run" | "remove" | "exists">,
): Promise<ServicePlan> {
  const plan = serviceRemovalPlan(target)
  for (const { command, args } of plan.commands) {
    try {
      await effects.run(command, args)
    } catch {
      // A manager that refuses to stop a service it does not know about must
      // not keep the file from going away.
    }
  }
  if (plan.kind === "file" && (await effects.exists(plan.path))) await effects.remove(plan.path)
  return plan
}

export async function serviceStatus(
  target: Pick<ServiceTarget, "platform" | "home" | "uid">,
  effects: Pick<ServiceEffects, "capture" | "exists">,
): Promise<ServiceStatus> {
  if (target.platform === "linux") {
    const path = unitPath(target.home)
    const installed = await effects.exists(path)
    const active = await effects.capture("systemctl", ["--user", "is-active", unitFile])
    const state = active.stdout.trim() === "" ? "unknown" : active.stdout.trim()
    return {
      installed,
      running: active.code === 0,
      detail: installed ? `${path} is ${state}` : `no service file at ${path}`,
    }
  }

  if (target.platform === "darwin") {
    const path = agentPath(target.home)
    const installed = await effects.exists(path)
    const printed = await effects.capture("launchctl", [
      "print",
      `gui/${assertUid(target.uid)}/${agentLabel}`,
    ])
    return {
      installed,
      running: printed.code === 0,
      detail: installed
        ? `${path} is ${printed.code === 0 ? "loaded" : "not loaded"}`
        : `no launch agent at ${path}`,
    }
  }

  if (target.platform === "win32") {
    const query = await effects.capture("schtasks", ["/query", "/tn", displayName, "/fo", "list"])
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
  environment?: ServiceEnvironment
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

  const target: ServiceTarget = {
    platform: dependencies.platform,
    execPath: dependencies.execPath,
    ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
    ...(dependencies.uid === undefined ? {} : { uid: dependencies.uid }),
    ...(dependencies.user === undefined ? {} : { user: dependencies.user }),
    ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
  }

  try {
    if (verb === "install") {
      const plan = await installService(target, dependencies)
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
    run: async (command, args) => {
      const { execFile } = await import("node:child_process")
      await new Promise<void>((resolve, reject) => {
        execFile(command, args, (error) => (error ? reject(error) : resolve()))
      })
    },
    capture: async (command, args) => {
      const { execFile } = await import("node:child_process")
      return new Promise<CapturedRun>((resolve) => {
        execFile(command, args, (error, stdout) => {
          const failure = error as (Error & { code?: unknown }) | null
          const code = typeof failure?.code === "number" ? failure.code : failure ? 1 : 0
          resolve({ code, stdout: stdout.toString() })
        })
      })
    },
    exists: async (path) => {
      try {
        await stat(path)
        return true
      } catch {
        return false
      }
    },
    remove: async (path) => {
      await rm(path, { force: true })
    },
  }
}
