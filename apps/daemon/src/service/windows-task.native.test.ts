import { randomUUID } from "node:crypto"
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { OperationDeadline, OperationDeadlineExceededError } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { withinServiceDeadline } from "./deadline.js"
import { nodeServiceEffects, removeService, serviceStatus, type ServiceCommand, type ServiceEffects } from "./install.js"
import { windowsPowerShellPath, windowsTaskRemovalPlan } from "./windows-task.js"
import { removeScratchDirectory } from "../test-scratch.js"

const lifecycleBudget = 60_000
const cleanupBudget = 30_000
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const powershell = (script: string): ServiceCommand => ({
  command: windowsPowerShellPath(),
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
})

it.runIf(process.platform === "win32")("reports and stops a real scheduled process before removing its task", async () => {
  // This is the native boundary, not an interception of Task Scheduler. Never
  // touch the operator's Domovoi task: preflight a UUID name and register with
  // TASK_CREATE (2), not CREATE_OR_UPDATE. No elevation or password is requested.
  const name = `Domovoi-removal-test-${randomUUID()}`
  const deadline = OperationDeadline.start(lifecycleBudget)
  const effects = nodeServiceEffects()
  const capture = (command: ServiceCommand, active: OperationDeadline) => withinServiceDeadline(active,
    () => effects.capture(command.command, command.args, active))
  const plan = windowsTaskRemovalPlan(name)
  let directory: string | undefined
  let created = false
  let pid: number | undefined
  // One budget covers preparation and the removal this test exists to prove,
  // and an expired one raises a bare deadline error naming neither. Both CI
  // expiries so far ended the test within 20 ms of the budget with no task
  // teardown left to run, so both spent it during preparation, which the error
  // could not say. Each phase records itself and expiry reports the last one.
  let phase = "task name preflight"
  try {
    const before = await capture(plan.inspect, deadline)
    expect(before).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
    phase = "fixture staging"
    directory = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-task-")))
    const scriptPath = join(directory, "task.mjs")
    const readyPath = join(directory, "ready")
    await withinServiceDeadline(deadline, () => copyFile(new URL("../../test-fixtures/service-task.mjs", import.meta.url), scriptPath))
    // A committed RegisterTaskDefinition is not undone by killing the
    // PowerShell an expired deadline abandons, and reading the flag from the
    // result records nothing when the call never returns, so the teardown
    // obligation is taken before the call rather than after it. Stopping a name
    // that was never registered prints domovoi-task:missing and exits 0, so the
    // cleanup below stays correct whichever way this lands.
    phase = "task registration"
    created = true
    const registered = await capture(powershell(`
$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$definition = $scheduler.NewTask(0)
$definition.Settings.ExecutionTimeLimit = 'PT2M'
$definition.Settings.AllowDemandStart = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$action = $definition.Actions.Create(0)
$action.Path = ${literal(process.execPath)}
$action.Arguments = ${literal(`"${scriptPath}" "${readyPath}"`)}
$null = $folder.RegisterTaskDefinition(${literal(name)}, $definition, 2, $definition.Principal.UserId, $null, 3, $null)
[Console]::Out.WriteLine('created')
`), deadline)
    expect(registered).toMatchObject({ code: 0, stdout: "created\r\n" })
    phase = "task start"
    await withinServiceDeadline(deadline, () => effects.run("schtasks", ["/run", "/tn", name], deadline))
    phase = "fixture liveness"
    await withinServiceDeadline(deadline, () => waitForDaemon(async () => {
      deadline.throwIfExpired()
      pid = Number(await withinServiceDeadline(deadline, () => readFile(readyPath, "utf8")))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      expect(() => process.kill(pid!, 0)).not.toThrow()
    }))
    // Run real status/removal orchestration and real subprocesses. The sole
    // substitution is the task name, so a /delete-only regression leaves the
    // test's live process behind and fails the liveness assertion below.
    const redirect = (command: string, args: string[]) => {
      if (command === windowsPowerShellPath()) {
        const source = windowsTaskRemovalPlan("Domovoi daemon")
        const key = (["stop", "inspect", "remove"] as const).find((key) => JSON.stringify(source[key].args) === JSON.stringify(args))
        if (!key) throw new Error("Unexpected Task Scheduler command")
        return plan[key]
      }
      expect(command).toBe("schtasks")
      expect(args).toEqual(["/delete", "/tn", "Domovoi daemon", "/f"])
      return { command, args: ["/delete", "/tn", name, "/f"] }
    }
    const scopedEffects: ServiceEffects = {
      ...effects,
      claimServiceOperation: nodeServiceEffects({ userHomeDirectory: directory! }).claimServiceOperation,
      capture: (command, args, active) => capture(redirect(command, args), active),
      run: (command, args, active) => {
        const redirected = redirect(command, args)
        return effects.run(redirected.command, redirected.args, active)
      },
    }
    phase = "service status"
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "win32" }, scopedEffects)))
      .toMatchObject({ installed: true, running: true })
    phase = "service removal"
    await withinServiceDeadline(deadline, () => removeService({ platform: "win32", home: directory! }, scopedEffects))
    phase = "stopped process observation"
    await withinServiceDeadline(deadline, () => waitForDaemon(() => {
      deadline.throwIfExpired()
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }))
    phase = "removed task inspection"
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "win32" }, scopedEffects)))
      .toMatchObject({ installed: false, running: false })
    created = false
  } catch (cause) {
    if (!(cause instanceof OperationDeadlineExceededError)) throw cause
    throw new Error(`The ${phase} step outlasted the ${lifecycleBudget}ms task lifecycle budget`, { cause })
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      if (created) {
        // A deliberately broken remover may have unregistered a live task.
        // Ask our finite fixture to exit through its private path, never kill
        // by a runtime name or a PID which might have since been reused.
        await withinServiceDeadline(cleanup, () => writeFile(join(directory!, "ready.stop"), "stop"))
        const stopped = await capture(plan.stop, cleanup)
        expect(stopped.code, stopped.stderr).toBe(0)
        if (pid !== undefined) await withinServiceDeadline(cleanup, () => waitForDaemon(() => {
          cleanup.throwIfExpired()
          expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
        }))
        if (stopped.stdout.trim() !== "domovoi-task:missing") {
          await withinServiceDeadline(cleanup, () => effects.run("schtasks", ["/delete", "/tn", name, "/f"], cleanup))
        }
      }
      // Removal stands on its own retry, so a cleanup budget the task
      // teardown spent does not leave the directory behind.
      if (directory) await removeScratchDirectory(directory)
    } finally { cleanup.clear() }
  }
}, lifecycleBudget + cleanupBudget + 1_000)
