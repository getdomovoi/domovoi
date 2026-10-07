import { randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"
import { launchWindowsJob, queryWindowsJob, queryWindowsProcess, type WindowsJob } from "./windows-job.js"
import { windowsPowerShellPath } from "./windows-task.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { readWindowsSupervisorRecord } from "./supervisor-record.js"
import { readWindowsSupervisorStatus, stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { OperationDeadline } from "../operation-deadline.js"

it.runIf(process.platform === "win32")("contains descendants, gates resume, refuses collisions, and cross-checks the boot counter", async () => {
  const directory = mkdtempSync(join(tmpdir(), "Domovoi-tëst-ü-"))
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
  const jobName = `Global\\Domovoi-${randomUUID()}`
  let job: WindowsJob | undefined
  try {
    vi.stubEnv("PSModulePath", "C:\\PowerShell 7\\Modules;C:\\Domovoi-tëst-ü\\User's Modules")
    const executable = process.execPath
    const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid,psModulePath:process.env.PSModulePath}));setInterval(()=>{},1000)`
    job = await launchWindowsJob({ job: jobName, executable, args: ["-e", script, marker], log: join(directory, "daemon.log") })
    expect(queryWindowsJob(jobName, job.prepared.child.pid)).toMatchObject({ jobExists: true, identity: job.prepared.child })
    expect(job.prepared).toMatchObject({ bootId: before.bootId, killOnClose: true, stdioOnly: true })
    await delay(250)
    expect(existsSync(marker)).toBe(false)
    // The second helper must refuse ERROR_ALREADY_EXISTS, not join or change
    // the live job. It never owns the first helper's handle.
    await expect(launchWindowsJob({ job: jobName, executable, args: ["-e", "process.exit(0)"], log: join(directory, "other.log") })).rejects.toThrow()
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
    process.kill(job.prepared.child.pid, "SIGKILL")
    expect(await job.exited).toMatchObject({ activeProcesses: 0, terminated: true, stopped: false, bootId: before.bootId })
    expect(queryWindowsProcess(pids!.descendant).identity).not.toEqual(descendant)
    expect(queryWindowsProcess(process.pid)).toEqual(before)
  } finally {
    vi.unstubAllEnvs()
    // Never delete the proof directory if cleanup cannot be established.
    if (job) await job.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}, 90_000)


function supervisorFixture(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix)), directory = join(home, ".domovoi")
  mkdirSync(directory)
  const path = join(directory, "service.json"), marker = join(directory, "descendant.json")
  const config = { ...createServiceConfiguration({ DOMOVOI_PROFILE_DIR: directory }, { platform: "win32", homeDirectory: home, workingDirectory: home }), registrationId: randomUUID() }
  writeFileSync(path, serializeServiceConfiguration(config))
  const childScript = `const {spawn}=require('node:child_process');const {writeFileSync,renameSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:process.pid,descendant:child.pid}));renameSync(process.argv[1]+'.tmp',process.argv[1]);setInterval(()=>{},1000)`
  const supervisorScript = `import {runWindowsSupervisor} from ${JSON.stringify(new URL("./windows-job-supervisor.ts", import.meta.url).href)};const record=await runWindowsSupervisor(process.argv[1],{executable:process.execPath,args:['-e',${JSON.stringify(childScript)},process.argv[2]]});if(record.state==='failed')process.exitCode=1`
  let output = ""
  const start = () => {
    output = ""
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", supervisorScript, path, marker],
      { env: { ...process.env, DOMOVOI_PROFILE_DIR: directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    child.stdout.resume(); child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-4096) })
    return child
  }
  const deadline = OperationDeadline.start(120_000)
  let supervisor = start()
  const ended = () => supervisor.exitCode !== null || supervisor.signalCode !== null
  const diagnostics = () => {
    let recorded: string
    try {
      const record = readWindowsSupervisorRecord(home)
      recorded = `state=${record?.state ?? "missing"}, reason=${record?.reason ?? "none"}`
    } catch (error) { recorded = `record read failed: ${String(error)}` }
    return `exitCode=${supervisor.exitCode}, signal=${supervisor.signalCode}, ${recorded}: ${output}`
  }
  const poll = async (phase: string, check: () => boolean, allowExit = false) => {
    while (!check()) {
      if (!allowExit && ended()) throw new Error(`Supervisor exited while waiting for ${phase}: ${diagnostics()}`)
      if (deadline.signal.aborted) throw new Error(`Timed out waiting for ${phase}: ${diagnostics()}`)
      await delay(100)
    }
  }
  const cleanup = async () => {
    deadline.clear()
    const cleanup = OperationDeadline.start(30_000)
    try {
      await stopWindowsSupervisor(path, cleanup)
      while (!ended()) { cleanup.throwIfExpired(); await delay(100) }
      // A failed proof retains the test profile and its evidence for inspection.
      rmSync(home, { recursive: true, force: true })
    } finally { cleanup.clear() }
  }
  return { home, directory, marker, poll, ended, restart: () => { supervisor = start() }, cleanup }
}

it.runIf(process.platform === "win32")("recovers a supervisor after helper death closes its Global job", async () => {
  const f = supervisorFixture("domovoi-helper-death-")
  const { home, marker, poll, ended } = f
  try {
    await poll("first running attempt", () => readWindowsSupervisorRecord(home)?.state === "running" && existsSync(marker))
    const first = readWindowsSupervisorRecord(home)!, attempt = first.attempts[0]!
    expect(attempt).toMatchObject({ killOnClose: true, job: expect.stringMatching(/^Global\\Domovoi-/) })
    const pids = JSON.parse(readFileSync(marker, "utf8")) as { descendant: number }
    const descendant = queryWindowsProcess(pids.descendant).identity
    expect(descendant).not.toBeNull()
    process.kill(attempt.helper!.pid, "SIGKILL")
    await poll("old supervisor exit", ended, true)
    await poll("descendant termination", () => queryWindowsProcess(pids.descendant).identity?.start !== descendant!.start, true)
    expect(queryWindowsJob(attempt.job, attempt.child!.pid)).toMatchObject({ jobExists: false, identity: null })
    expect(readWindowsSupervisorStatus(home)).toMatchObject({ detail: expect.stringContaining("completion not observed") })
    f.restart()
    await poll("replacement running attempt", () => {
      const record = readWindowsSupervisorRecord(home)
      return record?.state === "running" && record.supervisorId !== first.supervisorId
    })
    expect(readWindowsSupervisorRecord(home)!.attempts[0]!.job).not.toBe(attempt.job)
  } finally { await f.cleanup() }
}, 155_000)

it.runIf(process.platform === "win32")("keeps supervising while an open record delays crash publication", async () => {
  const f = supervisorFixture("domovoi-record-held-")
  let handle: number | undefined
  try {
    await f.poll("first running attempt", () => readWindowsSupervisorRecord(f.home)?.state === "running" && existsSync(f.marker))
    const first = readWindowsSupervisorRecord(f.home)!, attempt = first.attempts[0]!
    handle = openSync(join(f.directory, "windows-supervisor.json"), "r")
    // Only kill the daemon. Its helper must close the job and report the crash
    // while the test's open target prevents replacement of the record.
    process.kill(attempt.child!.pid, "SIGKILL")
    await f.poll("daemon termination", () => queryWindowsProcess(attempt.child!.pid).identity?.start !== attempt.child!.start)
    await delay(1_500)
    closeSync(handle); handle = undefined
    await f.poll("second running attempt", () => {
      const record = readWindowsSupervisorRecord(f.home)
      return record?.state === "running" && record.supervisorId === first.supervisorId && record.attempts.length === 2 && record.crashes === 1
    })
    expect(f.ended()).toBe(false)
  } finally {
    if (handle !== undefined) closeSync(handle)
    await f.cleanup()
  }
}, 155_000)
