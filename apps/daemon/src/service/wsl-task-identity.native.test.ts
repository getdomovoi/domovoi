import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { removeScratchDirectory } from "../test-scratch.js"
import { windowsPowerShellPath } from "./windows-task.js"
import { wslTaskPlan } from "./wsl-task.js"

const run = promisify(execFile)
const decode = (args: readonly string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le")

// Execute the generated PowerShell, but replace the scheduler COM boundary.
// Registration builds its real definition into this in-memory task. No Windows
// task is created, started or removed, including on an assertion failure.
const schedulerFixture = `
$ErrorActionPreference = 'Stop'
$script:fixtureAction = @{}
$script:fixtureTrigger = @{}
$fixtureActions = [pscustomobject]@{ Count = 0 }
$fixtureActions | Add-Member ScriptMethod Create {
  param($type)
  $script:fixtureAction.Type = $type
  $this.Count = 1
  return $script:fixtureAction
}
$fixtureActions | Add-Member ScriptMethod Item {
  param($index)
  if ($index -ne 1) { throw 'Unexpected action index' }
  return $script:fixtureAction
}
$fixtureTriggers = [pscustomobject]@{}
$fixtureTriggers | Add-Member ScriptMethod Create {
  param($type)
  $script:fixtureTrigger.Type = $type
  return $script:fixtureTrigger
}
$script:fixtureDefinition = @{
  RegistrationInfo = @{}; Principal = @{}; Settings = @{}
  Triggers = $fixtureTriggers; Actions = $fixtureActions
}
$script:fixtureTask = [pscustomobject]@{ Definition = $script:fixtureDefinition; State = 3 }
$script:fixtureFolder = [pscustomobject]@{}
$script:fixtureFolder | Add-Member ScriptMethod RegisterTaskDefinition {
  param($name, $definition, $flags, $user, $password, $logonType, $sddl)
  $script:fixtureTask.Definition = $definition
  return $script:fixtureTask
}
$script:fixtureFolder | Add-Member ScriptMethod GetTask { param($name); return $script:fixtureTask }
$script:fixtureScheduler = [pscustomobject]@{}
$script:fixtureScheduler | Add-Member ScriptMethod Connect {}
$script:fixtureScheduler | Add-Member ScriptMethod GetFolder { param($path); return $script:fixtureFolder }
$script:fixtureScheduler | Add-Member ScriptMethod NewTask { param($flags); return $script:fixtureDefinition }
function New-Object {
  param([string]$ComObject)
  if ($ComObject -cne 'Schedule.Service') { throw 'Unexpected COM boundary' }
  return $script:fixtureScheduler
}
`

async function inspectInjectedTask(change: string, oldUserComparison = false) {
  const powershell = windowsPowerShellPath()
  const plan = wslTaskPlan({
    name: "Domovoi injected task",
    registrationId: "08a1f2da-12e3-4b2c-9e4f-0123456789ab",
    distribution: "injected-distribution", linuxUser: "fixture",
    executable: "/usr/bin/node", args: ["/fixture/daemon.js"],
    powershell, wsl: "C:\\Windows\\System32\\wsl.exe",
  })
  let inspect = decode(plan.inspect.args)
  if (oldUserComparison) {
    const condition = "-not $taskUserSid.Equals($currentUserSid)"
    expect(inspect).toContain(condition)
    inspect = inspect.replace(condition, "$task.Definition.Principal.UserId -cne $ownerSid")
  }
  const directory = await mkdtemp(join(tmpdir(), "domovoi-task-identity-"))
  let outcome: { result: { stdout: string; stderr: string } } | { error: unknown }
  try {
    const path = join(directory, "probe.ps1")
    await writeFile(path, [schedulerFixture, "& {", decode(plan.register.args), "} | Out-Null", change,
      "& {", inspect, "}", ""].join("\n"), { mode: 0o600, flag: "wx" })
    // A file avoids re-encoding two commands beyond Windows' command-line cap.
    // ExecutionPolicy applies only to this process and its private test script.
    const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path], {
      timeout: 10_000, killSignal: "SIGKILL", windowsHide: true,
    })
    outcome = { result }
  } catch (error) {
    outcome = { error }
  }
  let cleanupFailure: { error: unknown } | undefined
  try { await removeScratchDirectory(directory) } catch (error) { cleanupFailure = { error } }
  if ("error" in outcome) {
    if (cleanupFailure) throw new AggregateError([outcome.error, cleanupFailure.error], "Task guard probe and cleanup failed", { cause: outcome.error })
    throw outcome.error
  }
  if (cleanupFailure) throw cleanupFailure.error
  return outcome.result
}

describe.runIf(process.platform === "win32")("WSL task ownership guard in Windows PowerShell", () => {
  it.each([
    { form: "SID", change: "" },
    { form: "account name", change: "$script:fixtureTask.Definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name" },
  ])("accepts the current user expressed as $form", async ({ change }) => {
    expect((await inspectInjectedTask(change)).stdout.trim()).toBe("domovoi-task:3")
  }, 15_000)

  it.each([
    { term: "Source", change: "$script:fixtureTask.Definition.RegistrationInfo.Source = 'unrelated-registration'" },
    { term: "UserId", change: "$script:fixtureTask.Definition.Principal.UserId = 'S-1-0-0'" },
    { term: "LogonType", change: "$script:fixtureTask.Definition.Principal.LogonType = 2" },
    { term: "RunLevel", change: "$script:fixtureTask.Definition.Principal.RunLevel = 1" },
    { term: "action count", change: "$script:fixtureTask.Definition.Actions.Count = 2" },
    { term: "action type", change: "$script:fixtureAction.Type = 5" },
    { term: "action path", change: "$script:fixtureAction.Path = 'C:\\unrelated.exe'" },
    { term: "action args", change: "$script:fixtureAction.Arguments = '--unrelated'" },
  ])("refuses an injected $term mismatch and names that term", async ({ term, change }) => {
    await expect(inspectInjectedTask(change)).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("WSL task ownership mismatch: " + term),
    })
  }, 15_000)

  it("names UserId when the identity cannot be resolved", async () => {
    await expect(inspectInjectedTask("$script:fixtureTask.Definition.Principal.UserId = ''")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("WSL task UserId could not be resolved to a SID"),
    })
  }, 15_000)

  it("detects restoring the raw-string comparison for an account-name principal", async () => {
    await expect(inspectInjectedTask(
      "$script:fixtureTask.Definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name", true,
    )).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("WSL task ownership mismatch: UserId") })
  }, 15_000)
})
