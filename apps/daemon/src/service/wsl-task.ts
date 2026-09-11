import { posix } from "node:path"

import type { ServiceCommand } from "./install.js"
import type { WindowsTaskRemovalPlan } from "./windows-task.js"

export type WslTaskTarget = {
  name: string
  registrationId: string
  distribution: string
  linuxUser: string
  executable: string
  args: readonly string[]
  // The caller resolves both native executables from the Windows directory.
  // powershell may be its translated absolute Linux path when using interop.
  powershell: string
  wsl: string
}

export type WslTaskPlan = {
  name: string
  register: ServiceCommand
  start: ServiceCommand
  disable: ServiceCommand
  inspect: ServiceCommand
  removal: WindowsTaskRemovalPlan
}

const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const invalidText = (value: string) => [...value].some((character) => character < " " || character === "\x7f")
const windowsAbsolute = (value: string) => /^[A-Za-z]:[\\/]/.test(value)
const state = "[Console]::Out.WriteLine('domovoi-task:' + [int]$task.State)"

// CommandLineToArgvW/CRT quoting, not shell quoting. A trailing backslash must
// double before the closing quote, just like a run immediately before a quote.
function argument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&") + '"'
}

export function wslTaskPlan(target: WslTaskTarget): WslTaskPlan {
  const values = [target.name, target.registrationId, target.distribution, target.linuxUser,
    target.executable, target.powershell, target.wsl, ...target.args]
  if (values.some((value) => value.length === 0 || invalidText(value))
    || target.name.length > 128 || target.name !== target.name.trim() || /[/\\]/.test(target.name)
    || target.name === "." || target.name === ".."
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.registrationId)
    || target.distribution.length > 128 || target.linuxUser.length > 256
    || !posix.isAbsolute(target.executable) || !windowsAbsolute(target.wsl)
    || !(windowsAbsolute(target.powershell) || posix.isAbsolute(target.powershell))
    || target.args.length > 128) {
    throw new Error("WSL task requires bounded names, a registration identity and absolute executables")
  }
  const args = ["--distribution", target.distribution, "--user", target.linuxUser,
    "--exec", target.executable, ...target.args].map(argument).join(" ")
  if (args.length > 16_384) throw new Error("WSL task action arguments exceed 16 Ki UTF-16 code units")
  const source = literal("domovoi-wsl:" + target.registrationId)
  const actionPath = literal(target.wsl)
  const actionArgs = literal(args)
  const common = `
$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$name = ${literal(target.name)}
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
`
  const command = (body: string): ServiceCommand => ({
    command: target.powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(common + body, "utf16le").toString("base64")],
  })
  // A name alone does not authorize mutation. Recheck the registration,
  // principal and exact action on every read/mutation, including deletion.
  const owned = `
try { $task = $folder.GetTask($name) } catch {
  if ($_.Exception.GetBaseException().HResult -eq -2147024894) {
    [Console]::Out.WriteLine('domovoi-task:missing')
    exit 0
  }
  throw
}
if ($task.Definition.RegistrationInfo.Source -cne ${source} -or
    $task.Definition.Principal.UserId -cne $ownerSid -or
    [int]$task.Definition.Principal.LogonType -ne 3 -or
    [int]$task.Definition.Principal.RunLevel -ne 0 -or
    $task.Definition.Actions.Count -ne 1) { throw 'WSL task ownership does not match this registration' }
$action = $task.Definition.Actions.Item(1)
if ([int]$action.Type -ne 0 -or $action.Path -cne ${actionPath} -or
    $action.Arguments -cne ${actionArgs}) { throw 'WSL task action changed; refusing to manage it' }
`
  const inspect = command(owned + state)
  const plan: WslTaskPlan = {
    name: target.name,
    register: command(`
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.Source = ${source}
$definition.RegistrationInfo.Description = 'Domovoi WSL daemon at user logon. No Windows boot supervision.'
$definition.Principal.UserId = $ownerSid
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $ownerSid
$trigger.Enabled = $true
$definition.Settings.Enabled = $true
$definition.Settings.AllowDemandStart = $true
$definition.Settings.MultipleInstances = 2
$definition.Settings.RestartInterval = 'PT1M'
$definition.Settings.RestartCount = 3
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.RunOnlyIfIdle = $false
$definition.Settings.RunOnlyIfNetworkAvailable = $false
$action = $definition.Actions.Create(0)
$action.Path = ${actionPath}
$action.Arguments = ${actionArgs}
$null = $folder.RegisterTaskDefinition($name, $definition, 2, $ownerSid, $null, 3, $null)
[Console]::Out.WriteLine('domovoi-task:created')
`),
    start: command(owned + "\n$null = $task.Run($null)\n" + state),
    // Disable first without stopping wsl.exe. The caller must then stop and
    // prove the guest process before removal can authorize profile recovery.
    disable: command(owned + "\n$task.Enabled = $false\n" + state),
    inspect,
    removal: {
      kind: "task", name: target.name, inspect,
      stop: command(owned + `
$task.Enabled = $false
try { $task.Stop(0) } catch {
  if ($_.Exception.GetBaseException().HResult -ne -2147216629) { throw }
}
${state}`),
      remove: command(owned + `
if ([int]$task.State -ne 1) { throw 'The WSL task is no longer disabled and stopped' }
$folder.DeleteTask($name, 0)
[Console]::Out.WriteLine('domovoi-task:deleted')
`),
    },
  }
  // PowerShell's encoded script is itself a Windows process command line.
  // Checking the guest argv alone misses its UTF-16/base64 expansion.
  for (const entry of [plan.register, plan.start, plan.disable, plan.inspect,
    plan.removal.stop, plan.removal.inspect, plan.removal.remove]) {
    if (entry.command.length + entry.args.join(" ").length > 30_000) {
      throw new Error("Encoded WSL task command exceeds the Windows command-line budget")
    }
  }
  return plan
}
