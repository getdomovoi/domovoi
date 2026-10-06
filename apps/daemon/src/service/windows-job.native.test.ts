import { randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"
import { launchWindowsJob, queryWindowsProcess, type WindowsJob } from "./windows-job.js"
import { windowsPowerShellPath } from "./windows-task.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { readWindowsSupervisorRecord } from "./supervisor-record.js"
import { stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { OperationDeadline } from "../operation-deadline.js"
import { windowsJobReceiptPath, windowsJobReceiptSchema } from "./windows-job-receipt.js"

it.runIf(process.platform === "win32").each(["root-exit", "session-end"] as const)("contains descendants, gates resume and receipts %s", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-job-"))
  const marker = join(directory, "child.json")
  const before = queryWindowsProcess(process.pid)
  expect(before.identity?.pid).toBe(process.pid)
  // Independent source: the boot counter persisted by Windows prefetching,
  // compared with the helper's KUSER_SHARED_DATA read. No elevation or skip
  // on missing registry data: CI must demonstrate both limited-user reads.
  const registry = String.raw`$key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters');if($null -eq $key){throw 'Boot counter unavailable'};try{$value=$key.GetValue('BootId');if($null -eq $value){throw 'Boot counter unavailable'};[Console]::Out.WriteLine([BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$value),0))}finally{$key.Dispose()}`
  const counter = execFileSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(registry, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 20_000, windowsHide: true }).trim()
  expect(counter).toMatch(/^(?:0|[1-9][0-9]*)$/)
  expect(before.bootId).toBe(`windows-boot:${counter}`)
  const jobName = `Local\\Domovoi-${randomUUID()}`
  const receipt = { path: join(directory, `windows-job-${jobName.slice(14)}.receipt.json`), registrationId: randomUUID(), attempt: 1, bootId: before.bootId }
  let job: WindowsJob | undefined
  try {
    vi.stubEnv("PSModulePath", "C:\\PowerShell 7\\Modules;C:\\User's Modules")
    const executable = process.execPath
    const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid,psModulePath:process.env.PSModulePath}));setInterval(()=>{},1000)`
    job = await launchWindowsJob({ job: jobName, receipt, executable, args: ["-e", script, marker], log: join(directory, "daemon.log") })
    expect(job.prepared).toMatchObject({ bootId: before.bootId, killOnClose: true, stdioOnly: true })
    await delay(250)
    expect(existsSync(marker)).toBe(false)
    // The second helper must refuse ERROR_ALREADY_EXISTS, not join or change
    // the live job. It never owns the first helper's handle.
    await expect(launchWindowsJob({ job: jobName, receipt, executable, args: ["-e", "process.exit(0)"], log: join(directory, "other.log") })).rejects.toThrow()
    await job.resume()
    let pids: { pid: number; descendant: number; psModulePath: string } | undefined
    for (let i = 0; i < 100 && !pids; ++i) {
      if (existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8")) as typeof pids
      else await delay(50)
    }
    expect(pids?.pid).toBe(job.prepared.child.pid)
    expect(pids?.descendant).toBeGreaterThan(0)
    expect(pids?.psModulePath).toBe(process.env.PSModulePath)
    const descendant = queryWindowsProcess(pids!.descendant).identity
    expect(descendant).not.toBeNull()
    // Kill only the root. Descendant cleanup must come from the job helper.
    if (mode === "root-exit") process.kill(job.prepared.child.pid, "SIGKILL")
    else sendEndSession(jobName, job.prepared.helper.pid)
    expect(await job.exited).toMatchObject({ activeProcesses: 0, terminated: true, stopped: mode === "session-end", bootId: before.bootId })
    expect(windowsJobReceiptSchema.parse(JSON.parse(readFileSync(receipt.path, "utf8")))).toMatchObject({
      job: jobName, bootId: before.bootId, attempt: 1, registrationId: receipt.registrationId, activeProcesses: 0,
    })
    const aclScript = String.raw`$ErrorActionPreference='Stop';$path=[Console]::In.ReadLine();$acl=Get-Acl -LiteralPath $path;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow'){throw 'Receipt is not private'}`
    execFileSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(aclScript, "utf16le").toString("base64")],
      { input: receipt.path + "\n", encoding: "utf8", timeout: 20_000, windowsHide: true })
    expect(queryWindowsProcess(pids!.descendant).identity).not.toEqual(descendant)
    expect(queryWindowsProcess(process.pid)).toEqual(before)
  } finally {
    vi.unstubAllEnvs()
    // Never delete the proof directory if cleanup cannot be established.
    if (job) await job.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)


// Address only this test's UUID window and verify its PID and top-level shape.
// This exercises the real window procedure without signing the CI user out.
function sendEndSession(name: string, pid: number) {
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SessionMessage {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
}
'@
$request=[Console]::In.ReadLine() | ConvertFrom-Json
$hwnd=[SessionMessage]::FindWindow($null,$request.name)
[uint32]$owner=0
$null=[SessionMessage]::GetWindowThreadProcessId($hwnd,[ref]$owner)
if($hwnd -eq [IntPtr]::Zero -or $owner -ne $request.pid -or [SessionMessage]::GetParent($hwnd) -ne [IntPtr]::Zero -or [SessionMessage]::IsWindowVisible($hwnd)){throw 'Wrong helper window'}
[IntPtr]$result=[IntPtr]::Zero
if([SessionMessage]::SendMessageTimeout($hwnd,0x11,[IntPtr]::Zero,[IntPtr]::Zero,2,15000,[ref]$result) -eq [IntPtr]::Zero -or $result -ne [IntPtr]1){throw 'Query end session failed'}
if([SessionMessage]::SendMessageTimeout($hwnd,0x16,[IntPtr]1,[IntPtr]::Zero,2,15000,[ref]$result) -eq [IntPtr]::Zero){throw 'End session failed'}
`
  execFileSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input: JSON.stringify({ name, pid }) + "\n", encoding: "utf8", timeout: 40_000, windowsHide: true })
}

it.runIf(process.platform === "win32")("receipts stdin EOF after only the Node supervisor dies and gates the next start on it", async () => {
  const home = mkdtempSync(join(tmpdir(), "domovoi-eof-")), directory = join(home, ".domovoi")
  mkdirSync(directory)
  const path = join(directory, "service.json"), marker = join(directory, "descendant.json")
  const config = { ...createServiceConfiguration({ DOMOVOI_PROFILE_DIR: directory }, { platform: "win32", homeDirectory: home, workingDirectory: home }), registrationId: randomUUID() }
  writeFileSync(path, serializeServiceConfiguration(config))
  const childScript = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000)`
  const supervisorScript = `import {runWindowsSupervisor} from ${JSON.stringify(new URL("./windows-job-supervisor.ts", import.meta.url).href)};await runWindowsSupervisor(process.argv[1],{executable:process.execPath,args:['-e',${JSON.stringify(childScript)},process.argv[2]]})`
  const start = () => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", supervisorScript, path, marker],
      { env: { ...process.env, DOMOVOI_PROFILE_DIR: directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    child.stdout.resume(); child.stderr.resume()
    return child
  }
  const deadline = OperationDeadline.start(100_000)
  const poll = async (check: () => boolean) => {
    while (!check()) { deadline.throwIfExpired(); await delay(100, undefined, { signal: deadline.signal }) }
  }
  let supervisor = start()
  try {
    await poll(() => readWindowsSupervisorRecord(home)?.state === "running" && existsSync(marker))
    const first = readWindowsSupervisorRecord(home)!, attempt = first.attempts[0]!
    const pids = JSON.parse(readFileSync(marker, "utf8")) as { descendant: number }
    const descendant = queryWindowsProcess(pids.descendant).identity
    expect(descendant).not.toBeNull()
    supervisor.kill("SIGKILL")
    const receiptPath = windowsJobReceiptPath(home, attempt.job)
    await poll(() => existsSync(receiptPath))
    expect(windowsJobReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")))).toMatchObject({
      job: attempt.job, registrationId: config.registrationId, attempt: 1, activeProcesses: 0, terminated: true,
    })
    expect(queryWindowsProcess(pids.descendant).identity).not.toEqual(descendant)
    expect(readWindowsSupervisorRecord(home)!.attempts[0]!.empty).toBeNull()
    supervisor = start()
    await poll(() => {
      const record = readWindowsSupervisorRecord(home)
      return record?.state === "running" && record.supervisorId !== first.supervisorId
    })
    expect(readWindowsSupervisorRecord(home)!.attempts[0]!.job).not.toBe(attempt.job)
  } finally {
    try {
      await stopWindowsSupervisor(path, deadline)
      supervisor.kill("SIGTERM")
      rmSync(home, { recursive: true, force: true })
    } finally { deadline.clear() }
  }
}, 110_000)
