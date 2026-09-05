import { setTimeout as delay } from "node:timers/promises"

import type { OperationDeadline } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceCommand, ServiceEffects } from "./install.js"

export type WindowsTaskRemovalPlan = {
  kind: "task"
  name: string
  stop: ServiceCommand
  inspect: ServiceCommand
  remove: ServiceCommand
}

export class WindowsTaskRemovalError extends Error {
  constructor(name: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Could not confirm removal of Windows task "${name}". Inspect Task Scheduler and the saved service configuration before retrying: ${detail}`, { cause })
    this.name = "WindowsTaskRemovalError"
  }
}

function taskCommand(name: string, body: string): ServiceCommand {
  // PowerShell is only a bridge to the typed Task Scheduler API. No localized
  // schtasks output decides whether a process is stopped. Encode the script as
  // UTF-16LE and quote the one literal, never interpolate a shell command line.
  const script = `
$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$name = '${name.replaceAll("'", "''")}'
try { $task = $folder.GetTask($name) } catch {
  if ($_.Exception.GetBaseException().HResult -eq -2147024894) {
    [Console]::Out.WriteLine('domovoi-task:missing')
    exit 0
  }
  throw
}
${body}
`
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  }
}

export function windowsTaskRemovalPlan(name: string): WindowsTaskRemovalPlan {
  return {
    kind: "task", name,
    // Disabling first also prevents queued/logon starts between stop and delete.
    // Stop can race normal exit; only SCHED_E_TASK_NOT_RUNNING is benign, and
    // even that must be followed by the same stopped-state proof.
    stop: taskCommand(name, `
$task.Enabled = $false
try { $task.Stop(0) } catch {
  if ($_.Exception.GetBaseException().HResult -ne -2147216629) { throw }
}
[Console]::Out.WriteLine('domovoi-task:' + [int]$task.State)`),
    inspect: taskCommand(name, "[Console]::Out.WriteLine('domovoi-task:' + [int]$task.State)"),
    // Re-read at the destructive seam too. TASK_STATE_DISABLED (1) means no
    // queued or running instances, unlike a successful unregister operation.
    // https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-state
    remove: taskCommand(name, `
if ([int]$task.State -ne 1) { throw 'The task is no longer disabled and stopped' }
$folder.DeleteTask($name, 0)
[Console]::Out.WriteLine('domovoi-task:deleted')`),
  }
}

async function taskResult(command: ServiceCommand, effects: Pick<ServiceEffects, "capture">, deadline: OperationDeadline): Promise<string> {
  const result = await withinServiceDeadline(deadline, () => effects.capture(command.command, command.args, deadline))
  if (result.code !== 0) throw new Error(result.stderr?.trim() || `Task Scheduler command exited with code ${result.code}`)
  const match = /^domovoi-task:(missing|deleted|[0-4])$/.exec(result.stdout.trim())
  if (!match) throw new Error("Task Scheduler returned an unrecognized state")
  return match[1]!
}

export async function removeWindowsTask(plan: WindowsTaskRemovalPlan, effects: Pick<ServiceEffects, "capture">, deadline: OperationDeadline): Promise<void> {
  try {
    let state = await taskResult(plan.stop, effects, deadline)
    // Absence before any stop attempt is idempotent. Once an instance may have
    // been running, disappearance of its registration does not prove it died.
    if (state === "missing") return
    while (state === "2" || state === "4") {
      await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal }))
      state = await taskResult(plan.inspect, effects, deadline)
    }
    if (state !== "1") throw new Error(`Task Scheduler did not confirm a disabled, stopped task (state ${state})`)
    if (await taskResult(plan.remove, effects, deadline) !== "deleted") {
      throw new Error("Task registration disappeared before removal could be confirmed")
    }
  } catch (cause) {
    throw new WindowsTaskRemovalError(plan.name, cause)
  }
}
