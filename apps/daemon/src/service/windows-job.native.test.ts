import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"
import { launchWindowsJob, queryWindowsProcess, type WindowsJob } from "./windows-job.js"
import { windowsPowerShellPath } from "./windows-task.js"

it.runIf(process.platform === "win32")("contains descendants, gates resume, refuses collisions, and cross-checks the boot counter", async () => {
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
  let job: WindowsJob | undefined
  try {
    const executable = process.execPath
    const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000)`
    job = await launchWindowsJob({ job: jobName, executable, args: ["-e", script, marker], log: join(directory, "daemon.log") })
    expect(job.prepared).toMatchObject({ bootId: before.bootId, killOnClose: true })
    await delay(250)
    expect(existsSync(marker)).toBe(false)
    // The second helper must refuse ERROR_ALREADY_EXISTS, not join or change
    // the live job. It never owns the first helper's handle.
    await expect(launchWindowsJob({ job: jobName, executable, args: ["-e", "process.exit(0)"], log: join(directory, "other.log") })).rejects.toThrow()
    await job.resume()
    let pids: { pid: number; descendant: number } | undefined
    for (let i = 0; i < 100 && !pids; ++i) {
      if (existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8")) as typeof pids
      else await delay(50)
    }
    expect(pids?.pid).toBe(job.prepared.child.pid)
    expect(pids?.descendant).toBeGreaterThan(0)
    // Kill only the root. Descendant cleanup must come from the job helper.
    process.kill(job.prepared.child.pid, "SIGKILL")
    expect(await job.exited).toMatchObject({ activeProcesses: 0, terminated: true, stopped: false, bootId: before.bootId })
    expect(() => process.kill(pids!.descendant, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    expect(queryWindowsProcess(process.pid)).toEqual(before)
  } finally {
    // Never delete the proof directory if cleanup cannot be established.
    if (job) await job.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}, 90_000)
