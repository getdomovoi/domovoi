import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { nativeServiceTestsEnabled } from "../test-native-service-gate.js"
import { removeScratchDirectory } from "../test-scratch.js"
import { createServiceConfiguration } from "./configuration.js"
import { stagedRuntimeCopy } from "./desktop-service.js"
import { isDomovoiTaskAction, nodeServiceEffects, servicePlan, type ServiceCommand } from "./install.js"
import { readWindowsTaskAction, removeWindowsTask, windowsPowerShellPath, windowsSchtasksPath, windowsTaskRegistrationCommand, windowsTaskRemovalPlan } from "./windows-task.js"

// Task 50: the installer registers its logon task through the Task Scheduler
// COM API, the program and its arguments apart, instead of schtasks /create
// /tr, which refuses a command over 261 characters (#771). These run the real
// Task Scheduler under task names of their own, read each task back through
// every reader Domovoi has (the typed action read, the ownership check, and
// the desktop's schtasks /query /xml reading), and delete what they made,
// whatever the outcome. Registering a logon task starts nothing.
// An interrupted run leaves those tasks registered in the account that ran it,
// so they run on CI and, on a developer machine, only with
// DOMOVOI_NATIVE_SERVICE_TESTS=1.
const windowsNative = process.platform === "win32" && nativeServiceTestsEnabled("Windows")

const effects = nodeServiceEffects()
const decode = (command: ServiceCommand) => Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
// The installer's own registration, with only the task name redirected.
const renamed = (command: ServiceCommand, name: string): ServiceCommand => {
  const script = decode(command)
  const named = "$name = 'Domovoi daemon'"
  if (!script.includes(named)) throw new Error("The registration does not name the Domovoi task")
  return { command: command.command, args: [...command.args.slice(0, -1), Buffer.from(script.replace(named, `$name = '${name}'`), "utf16le").toString("base64")] }
}
const register = async (command: ServiceCommand, name: string, deadline: OperationDeadline) => {
  const named = renamed(command, name)
  await effects.run(named.command, named.args, deadline)
}
// Stdin is closed so a password prompt fails at once instead of waiting.
const schtasks = (args: string[]) => spawnSync(windowsSchtasksPath(), args, { input: "", encoding: "utf8", timeout: 30_000, windowsHide: true })
// schtasks may emit UTF-16 through its redirected output.
// Deletes each task whatever the test did. Every delete stands alone, and only
// Task Scheduler reporting the task missing afterwards counts as removed: a
// task it still lists, or one it cannot answer for, fails the test with the
// command that removes it by hand, and the test's own failure travels with it.
async function deleteTasks(names: string[], failures: unknown[]): Promise<void> {
  const left: string[] = []
  const deadline = OperationDeadline.start(60_000)
  try {
    for (const name of names) {
      schtasks(["/delete", "/tn", name, "/f"])
      const { inspect } = windowsTaskRemovalPlan(name)
      const state = await effects.capture(inspect.command, inspect.args, deadline).catch(() => undefined)
      if (state?.code !== 0 || state.stdout.trim() !== "domovoi-task:missing") left.push(name)
    }
  } finally { deadline.clear() }
  if (left.length > 0) {
    throw new AggregateError(failures, `Native Windows task cleanup did not complete. Run schtasks /delete /tn "<name>" /f for ${left.join(", ")}.`)
  }
}
const queryXml = (name: string) => {
  const queried = schtasks(["/query", "/tn", name, "/xml"])
  expect(queried.status, `${queried.stdout}${queried.stderr}`).toBe(0)
  return queried.stdout.replaceAll("\0", "")
}
const xmlAction = (xml: string) => ({
  command: /<Command>([^<]*)<\/Command>/u.exec(xml)?.[1],
  arguments: /<Arguments>([^<]*)<\/Arguments>/u.exec(xml)?.[1],
})
// Parse the XML with PowerShell's XML reader so entity-escaped account names
// compare as account data. Normalize differing name/SID forms through Windows.
async function assertTaskAccounts(legacyXml: string, currentXml: string, deadline: OperationDeadline): Promise<void> {
  const data = (value: string) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}'))`
  const script = `
$ErrorActionPreference = 'Stop'
$legacy = [xml](${data(legacyXml)})
$current = [xml](${data(currentXml)})
$principal = [string]$current.Task.Principals.Principal.UserId
$trigger = [string]$current.Task.Triggers.LogonTrigger.UserId
$legacyPrincipal = [string]$legacy.Task.Principals.Principal.UserId
function Resolve-Sid([string]$account) {
  if ($account -match '^S-1-') { return ([System.Security.Principal.SecurityIdentifier]::new($account)).Value }
  return ([System.Security.Principal.NTAccount]::new($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}
if (-not $principal -or -not $trigger -or -not $legacyPrincipal) { throw 'A task principal or COM logon trigger has no UserId' }
# PowerShell's -ieq is case-insensitive. Resolve account names only when forms differ.
$sameTrigger = $principal -ieq $trigger
if (-not $sameTrigger) { $sameTrigger = (Resolve-Sid $principal) -ieq (Resolve-Sid $trigger) }
$sameLegacy = $principal -ieq $legacyPrincipal
if (-not $sameLegacy) { $sameLegacy = (Resolve-Sid $principal) -ieq (Resolve-Sid $legacyPrincipal) }
[Console]::Out.WriteLine((ConvertTo-Json -Compress @{ sameTrigger = $sameTrigger; sameLegacy = $sameLegacy }))
`
  const result = await effects.capture(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], deadline)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ sameTrigger: true, sameLegacy: true })
}

const plan = (home: string, execPath: string, runtime: string) => servicePlan({
  platform: "win32", home, user: userInfo().username, execPath, runtime,
  configuration: createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
})

it.runIf(windowsNative)("registers the action an older Domovoi's schtasks /create /tr registered", async () => {
  const home = "C:\\Users\\dl"
  const runtime = "C:\\Program Files\\nodejs\\node.exe"
  const entry = "C:\\Program Files\\nodejs\\node_modules\\@getdomovoi\\cli\\node_modules\\@getdomovoi\\daemon\\dist\\index.js"
  const configurationPath = `${home}\\.domovoi\\service.json`
  const command = `"${runtime}" "${entry}" --service-supervise "${configurationPath}"`
  const legacy = `Domovoi-legacy-shape-test-${randomUUID()}`
  const current = `Domovoi-com-shape-test-${randomUUID()}`
  const deadline = OperationDeadline.start(120_000)
  const failures: unknown[] = []
  try {
    // What an older Domovoi ran, with this test's name and no /f.
    const created = schtasks(["/create", "/tn", legacy, "/tr", command, "/sc", "onlogon", "/ru", userInfo().username, "/rl", "LIMITED"])
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0)
    await register(plan(home, entry, runtime).commands[0]!, current, deadline)
    const legacyAction = await readWindowsTaskAction(legacy, effects, deadline)
    const currentAction = await readWindowsTaskAction(current, effects, deadline)
    expect(currentAction).not.toBe("missing")
    expect(legacyAction).not.toBe("missing")
    const shape = (action: typeof currentAction) => action === "missing" ? action : { path: action.path, arguments: action.arguments }
    expect(shape(currentAction)).toEqual(shape(legacyAction))
    expect(isDomovoiTaskAction(currentAction as Exclude<typeof currentAction, "missing">, configurationPath, { executable: runtime, entry })).toBe(true)
    const legacyXml = queryXml(legacy), currentXml = queryXml(current)
    expect(xmlAction(currentXml)).toEqual(xmlAction(legacyXml))
    // Run only while the user is logged on, with limited rights, as /ru with
    // no password and /rl LIMITED registered. Task Scheduler writes no
    // RunLevel element for limited rights (LeastPrivilege, the default), as
    // the first Windows run of this test showed for schtasks, so both must
    // carry the same RunLevel, and neither the highest one.
    const runLevel = (xml: string) => /<RunLevel>([^<]*)<\/RunLevel>/u.exec(xml)?.[1] ?? "LeastPrivilege"
    for (const xml of [legacyXml, currentXml]) {
      expect(xml).toMatch(/<LogonType>InteractiveToken<\/LogonType>/u)
      expect(runLevel(xml)).toBe("LeastPrivilege")
    }
    const block = (xml: string, element: string) => new RegExp(`<${element}>[\\s\\S]*?</${element}>`, "u").exec(xml)?.[0] ?? `no ${element}`
    console.log(`[task shape] schtasks principals and triggers:\n${block(legacyXml, "Principals")}\n${block(legacyXml, "Triggers")}`)
    console.log(`[task shape] COM principals and triggers:\n${block(currentXml, "Principals")}\n${block(currentXml, "Triggers")}`)
    await assertTaskAccounts(legacyXml, currentXml, deadline)
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    await deleteTasks([legacy, current], failures)
  }
}, 150_000)

it.runIf(windowsNative)("registers, reads back and removes a task command well over 261 characters", async () => {
  const base = await mkdtemp(join(tmpdir(), "domovoi-long-"))
  // A home and profile deep enough that the command is far over 261, with
  // the runtime copy's layout the desktop reader recognises. Nothing is
  // written under them; registering a logon task starts nothing.
  const home = join(base, "h".repeat(60))
  const profile = join(home, "p".repeat(60))
  const copy = join(profile, "runtime", "0.9.2", "0123456789ab")
  const runtime = join(copy, "node", "node.exe")
  const entry = join(copy, "daemon", "dist", "index.js")
  const configurationPath = join(home, ".domovoi", "service.json")
  const name = `Domovoi-long-command-test-${randomUUID()}`
  const deadline = OperationDeadline.start(120_000)
  const failures: unknown[] = []
  let removed = false
  try {
    const registration = plan(home, entry, runtime).commands[0]!
    const command = `"${runtime}" "${entry}" --service-supervise "${configurationPath}"`
    expect(command.length).toBeGreaterThan(400)
    await register(registration, name, deadline)
    const action = await readWindowsTaskAction(name, effects, deadline)
    expect(action).toMatchObject({ path: `"${runtime}"`, arguments: `"${entry}" --service-supervise "${configurationPath}"`, enabled: true })
    expect(isDomovoiTaskAction(action as Exclude<typeof action, "missing">, configurationPath, { executable: runtime, entry })).toBe(true)
    const xml = queryXml(name)
    expect(xmlAction(xml)).toEqual({ command: `"${runtime}"`, arguments: `"${entry}" --service-supervise "${configurationPath}"` })
    expect(stagedRuntimeCopy("win32", xml, profile, configurationPath)).toEqual({ version: "0.9.2", copy })
    for (const setting of ["<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"]) {
      expect(xml).toContain(setting)
    }
    expect(await removeWindowsTask(windowsTaskRemovalPlan(name), effects, deadline, true)).toBe("removed")
    removed = true
    expect(await readWindowsTaskAction(name, effects, deadline)).toBe("missing")
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    try { await deleteTasks(removed ? [] : [name], failures) }
    finally { await removeScratchDirectory(base) }
  }
}, 150_000)

// Task Scheduler's schema gives an Exec Command at most 260 characters
// (pathType). The installer refuses a longer program, quotes included; this
// shows the longest it registers is accepted, and records what Windows does
// one character over, which the installer never sends.
it.runIf(windowsNative)("registers a task program of 260 characters with its quotes", async () => {
  const home = "C:\\Users\\dl"
  const runtime = `C:\\${"n".repeat(246)}\\node.exe`
  const entry = "C:\\Program Files\\Domovoi\\dist\\index.js"
  const accepted = `Domovoi-program-length-test-${randomUUID()}`
  const over = `Domovoi-program-length-test-${randomUUID()}`
  const deadline = OperationDeadline.start(120_000)
  const failures: unknown[] = []
  try {
    const registration = plan(home, entry, runtime).commands[0]!
    await register(registration, accepted, deadline)
    const action = await readWindowsTaskAction(accepted, effects, deadline)
    expect(action).not.toBe("missing")
    expect((action as Exclude<typeof action, "missing">).path).toHaveLength(260)
    const longer = decode(windowsTaskRegistrationCommand("Domovoi daemon", userInfo().username, {
      path: runtime.replace("\\node.exe", "n\\node.exe"), arguments: `"${entry}" --service-supervise "C:\\Users\\dl\\.domovoi\\service.json"`,
    }))
    const probe = { command: registration.command, args: [...registration.args.slice(0, -1), Buffer.from(longer.replace("$name = 'Domovoi daemon'", `$name = '${over}'`), "utf16le").toString("base64")] }
    const outcome = await effects.run(probe.command, probe.args, deadline).then(() => "accepted", (error: unknown) => `refused: ${String(error)}`)
    console.log(`[task program length] a 261 character Command with its quotes was ${outcome}`)
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    await deleteTasks([accepted, over], failures)
  }
}, 150_000)

it.runIf(windowsNative)("round-trips smart and ASCII apostrophes in the program and arguments", async () => {
  const name = `Domovoi-quotes-test-${randomUUID()}`
  const action = { path: `"C:\\Users\\O’Neil'\\node.exe"`, arguments: `"C:\\Users\\O’Neil'\\index.js" --value "‘日本語'"` }
  const deadline = OperationDeadline.start(120_000)
  const failures: unknown[] = []
  let removed = false
  try {
    await register(windowsTaskRegistrationCommand("Domovoi daemon", userInfo().username, action), name, deadline)
    expect(await readWindowsTaskAction(name, effects, deadline)).toMatchObject(action)
    expect(await removeWindowsTask(windowsTaskRemovalPlan(name), effects, deadline, true)).toBe("removed")
    removed = true
    expect(await readWindowsTaskAction(name, effects, deadline)).toBe("missing")
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    await deleteTasks(removed ? [] : [name], failures)
  }
}, 150_000)
