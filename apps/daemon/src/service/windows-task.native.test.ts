import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { readLocalOwnerRecord } from "../local-owner-record.js"
import { withinServiceDeadline } from "./deadline.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { nodeServiceEffects, removeService, runServiceCommand, serviceStatus, type ServiceCommand, type ServiceEffects } from "./install.js"
import { windowsPowerShellPath, windowsSchtasksPath, windowsTaskRemovalPlan, windowsTaskSettingsCommand } from "./windows-task.js"
import { readWindowsSupervisorRecord, type WindowsSupervisorRecord } from "./supervisor-record.js"
import { stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { removeScratchDirectory } from "../test-scratch.js"

// Real 1/5/15 second backoffs plus Windows compiler, manager and startup time.
// No test speed knob is exposed in the production configuration.
const lifecycleBudget = 180_000
const cleanupBudget = 60_000
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const powershell = (script: string): ServiceCommand => ({ command: windowsPowerShellPath(),
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] })

it.runIf(process.platform === "win32").each(["exhaustion", "stop"] as const)("proves native Windows supervised %s and removal", async (mode) => {
  const name = `Domovoi-supervision-test-${randomUUID()}`
  const deadline = OperationDeadline.start(lifecycleBudget)
  const directory = await mkdtemp(join(tmpdir(), "domovoi-task-"))
  const profile = { profileDirectory: join(directory, "profile") }
  const path = serviceConfigurationPath(directory, "win32")
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
  const effects = nodeServiceEffects({ userHomeDirectory: directory })
  const plan = windowsTaskRemovalPlan(name)
  let created = false, started = false, removed = false
  const capture = (command: ServiceCommand, active = deadline) => withinServiceDeadline(active,
    () => effects.capture(command.command, command.args, active))
  const poll = async (test: () => boolean) => {
    while (!test()) { deadline.throwIfExpired(); await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal })) }
  }
  const record = () => readWindowsSupervisorRecord(profile)
  const readyInstance = () => {
    const owner = readLocalOwnerRecord(profile)
    if (owner?.state !== "ready") throw new Error("Expected a ready daemon owner")
    return owner.instanceId
  }
  const running = (attempt: number, previousInstance?: string) => {
    const state = record()
    const owner = readLocalOwnerRecord(profile)
    return state?.state === "running" && state.attempts.length === attempt && owner?.state === "ready"
      && owner.instanceId !== previousInstance
  }
  // The only substitution redirects the task name. All scheduler, helper,
  // record, status-handler and removal operations execute their real paths.
  const scoped: ServiceEffects = { ...effects, capture: (command, args, active) => {
    if (command !== windowsPowerShellPath()) throw new Error("Unexpected manager command")
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
    const named = `$name = ${literal("Domovoi daemon")}`
    if (!script.includes(named)) throw new Error("Refusing a command outside the UUID task")
    return capture(powershell(script.replace(named, `$name = ${literal(name)}`)), active)
  } }
  const killDaemon = (state: WindowsSupervisorRecord) => {
    const child = state.attempts.at(-1)?.child
    expect(child).not.toBeNull()
    process.kill(child!.pid, "SIGKILL")
  }
  try {
    expect(await capture(plan.inspect)).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
    await mkdir(join(directory, ".domovoi"), { recursive: true })
    await mkdir(profile.profileDirectory)
    const config = { ...createServiceConfiguration({ DOMOVOI_PROFILE_DIR: profile.profileDirectory, DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0" },
      { platform: "win32", homeDirectory: directory, workingDirectory: directory }), registrationId: randomUUID(),
      serviceRuntime: { executable: process.execPath, entry } }
    await writeFile(path, serializeServiceConfiguration(config))
    // TASK_CREATE (2), never overwrite an existing task. The same limited-user
    // logon shape as installation, but its name and profile belong to this test.
    created = true
    const registration = await capture(powershell(`
$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$definition = $scheduler.NewTask(0)
$definition.Settings.AllowDemandStart = $true
$definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $definition.Principal.UserId
$action = $definition.Actions.Create(0)
$action.Path = ${literal(process.execPath)}
$action.Arguments = ${literal(`"${entry}" --service-supervise "${path}"`)}
$null = $folder.RegisterTaskDefinition(${literal(name)}, $definition, 2, $definition.Principal.UserId, $null, 3, $null)
[Console]::Out.WriteLine('created')
`))
    expect(registration).toMatchObject({ code: 0, stdout: "created\r\n" })
    expect((await capture(windowsTaskSettingsCommand(name))).code).toBe(0)
    const xml = await capture({ command: windowsSchtasksPath(), args: ["/query", "/tn", name, "/xml"] })
    expect(xml.code).toBe(0)
    // schtasks may emit UTF-16 through its redirected output. These three XML
    // values are ASCII and their assertion is independent of its BOM.
    const settings = xml.stdout.replaceAll("\0", "")
    expect(settings).toMatch(/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
    expect(settings).toMatch(/<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/)
    expect(settings).toMatch(/<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/)
    started = true
    await withinServiceDeadline(deadline, () => effects.run(windowsSchtasksPath(), ["/run", "/tn", name], deadline))
    await poll(() => running(1))
    const first = record()!
    expect(await serviceStatus({ platform: "win32", home: directory }, scoped)).toMatchObject({ installed: true, running: true })
    if (mode === "exhaustion") {
      const firstInstance = readyInstance()
      killDaemon(first)
      await poll(() => running(2, firstInstance))
      const second = record()!
      expect(second.attempts[1]!.child!.pid).not.toBe(first.attempts[0]!.child!.pid)
      expect(second.attempts[0]!.empty).toMatchObject({ activeProcesses: 0, terminated: true })
      await withinServiceDeadline(deadline, () => delay(3_000, undefined, { signal: deadline.signal }))
      expect(record()).toMatchObject({ state: "running", crashes: 1 })
      expect(record()!.attempts).toHaveLength(2)
      expect(record()!.attempts[1]!.child!.pid).toBe(second.attempts[1]!.child!.pid)
      for (const next of [3, 4]) {
        const previousInstance = readyInstance()
        killDaemon(record()!)
        await poll(() => running(next, previousInstance))
      }
      killDaemon(record()!)
      await poll(() => record()?.state === "exhausted")
      expect(record()!.attempts).toHaveLength(4)
      const stdout = vi.fn(), stderr = vi.fn()
      // This is the production CLI handler's exit code, with only the manager
      // task name redirected. No default user task or profile is queried.
      expect(await runServiceCommand(["service", "status"], { ...scoped, platform: "win32", home: directory,
        execPath: entry, runtime: process.execPath, environment: { DOMOVOI_PROFILE_DIR: profile.profileDirectory }, stdout, stderr })).toBe(1)
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("supervision exhausted after 4 crashes"))
      expect(stderr).not.toHaveBeenCalled()
    } else {
      await stopWindowsSupervisor(path, deadline)
      expect(record()).toMatchObject({ state: "stopped", reason: "deliberate-stop" })
      await withinServiceDeadline(deadline, () => delay(3_000, undefined, { signal: deadline.signal }))
      expect(record()!.attempts).toHaveLength(1)
      expect(() => process.kill(first.attempts[0]!.child!.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }
    await removeService({ platform: "win32", home: directory }, scoped)
    expect(record()!.attempts.every((a) => a.empty?.activeProcesses === 0 && a.empty.terminated)).toBe(true)
    for (const attempt of record()!.attempts) expect(() => process.kill(attempt.child!.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    expect(await capture(plan.inspect)).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
    removed = true
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      if (created && !removed) {
        await capture(plan.disable!, cleanup)
        if (started) await stopWindowsSupervisor(path, cleanup)
        expect((await capture(plan.stop, cleanup)).code).toBe(0)
        const present = await capture(plan.inspect, cleanup)
        if (present.stdout.trim() !== "domovoi-task:missing") expect((await capture(plan.remove, cleanup)).code).toBe(0)
      }
      // A failed proof retains this directory and UUID task for inspection.
      await removeScratchDirectory(directory)
    } finally { cleanup.clear() }
  }
}, lifecycleBudget + cleanupBudget + 1_000)
