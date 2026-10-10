import { randomUUID } from "node:crypto"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"
import { launchWindowsJob, queryWindowsJob, queryWindowsProcess, windowsJobCommand, type WindowsJob } from "./windows-job.js"
import { windowsPowerShellPath } from "./windows-task.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { readWindowsSupervisorRecord } from "./supervisor-record.js"
import { readWindowsSupervisorStatus, stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { OperationDeadline } from "../operation-deadline.js"
import { nativeServiceTestsEnabled } from "../test-native-service-gate.js"

// These tests start real job objects, supervisors and daemon trees in the
// account that runs them, and an interrupted run leaves them running. They run
// on CI and, on a developer machine, only with DOMOVOI_NATIVE_SERVICE_TESTS=1.
const windowsNative = process.platform === "win32" && nativeServiceTestsEnabled("Windows")

it.runIf(windowsNative)("inspects a live process without module progress on stderr", () => {
  const command = windowsJobCommand()
  const result = spawnSync(command.command, command.args, {
    input: JSON.stringify({ mode: "inspect", pids: [process.pid] }) + "\n",
    encoding: "utf8", timeout: 90_000, windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ identities: [{ pid: process.pid }] })
  expect(result.stderr).toBe("")
}, 120_000)

it.runIf(windowsNative).each([
  { mode: "unknown" },
  { mode: 1 },
  { mode: "inspect", pids: [String(process.pid)] },
  { mode: "inspect", pids: process.pid },
  { mode: "inspect", pids: [] },
  { mode: "inspect", pids: Array.from({ length: 9 }, () => process.pid) },
  { mode: "inspect", pids: [-1] },
  { mode: "inspect", pids: [4_294_967_296] },
  { mode: "inspect", pids: [1.5] },
  { mode: "inspect", pids: [null] },
  { mode: "inspect", pids: [true] },
  { mode: "inspect-job", job: 1, pid: process.pid },
  { mode: "inspect-job", job: `Global\\Domovoi-${randomUUID()}`, pid: String(process.pid) },
  ...[
    { job: null }, { executable: 1 }, { log: null }, { args: "argument" },
    { args: [1] }, { args: [null] }, { psModulePath: false }, { psModulePath: undefined },
  ].map((invalid) => ({
    mode: "run", job: `Global\\Domovoi-${randomUUID()}`, executable: process.execPath,
    log: "NUL", args: [], psModulePath: null, ...invalid,
  })),
])("rejects invalid request %j without stdout evidence", (request) => {
  const command = windowsJobCommand()
  const result = spawnSync(command.command, command.args, {
    input: JSON.stringify(request) + "\n", encoding: "utf8", timeout: 90_000, windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Windows job helper failed; no shutdown proof. Error ")
}, 120_000)

it.runIf(windowsNative)("contains descendants, gates resume, refuses collisions, and cross-checks the boot counter", async () => {
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
  const failures: unknown[] = []
  try {
    vi.stubEnv("PSModulePath", "C:\\PowerShell 7\\Modules;C:\\Domovoi-tëst-ü\\User's Modules")
    const executable = process.execPath
    // The marker is renamed into place so the poll never reads a partial write.
    const script = `const {spawn}=require('node:child_process');const {writeFileSync,renameSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:process.pid,descendant:child.pid,psModulePath:process.env.PSModulePath}));renameSync(process.argv[1]+'.tmp',process.argv[1]);setInterval(()=>{},1000)`
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
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    vi.unstubAllEnvs()
    // Never delete the proof directory if cleanup cannot be established. The
    // test's own failure travels with a failed stop.
    try { if (job) await job.stop() } catch (error) {
      // Thrown from the finally, this replaces the body's own failure, so that
      // failure travels inside it.
      // eslint-disable-next-line no-unsafe-finally
      throw new AggregateError([...failures, error], "Native Windows job cleanup did not complete", { cause: error })
    }
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
  // The test's own failure travels with any cleanup failure.
  const cleanup = async (failures: unknown[]) => {
    deadline.clear()
    const cleanup = OperationDeadline.start(30_000)
    try {
      await stopWindowsSupervisor(path, cleanup)
      while (!ended()) { cleanup.throwIfExpired(); await delay(100) }
      // A failed proof retains the test profile and its evidence for inspection.
      rmSync(home, { recursive: true, force: true })
    } catch (error) {
      // A supervisor that did not stop keeps its job helper and the daemon
      // tree running in this account after the run. Node ends its own child
      // through the process handle it holds, never by a PID that may have
      // been reused. The helper reads a closed input as a stop and terminates
      // the job, which takes the daemon and its descendants with it.
      if (!ended()) supervisor.kill("SIGKILL")
      throw new AggregateError([...failures, error], "Native Windows supervisor cleanup did not complete", { cause: error })
    } finally { cleanup.clear() }
  }
  return { home, directory, marker, poll, ended, restart: () => { supervisor = start() }, cleanup }
}

it.runIf(windowsNative)("recovers a supervisor after helper death closes its Global job", async () => {
  const f = supervisorFixture("domovoi-helper-death-")
  const { home, marker, poll, ended } = f
  const failures: unknown[] = []
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
  } catch (error) {
    failures.push(error)
    throw error
  } finally { await f.cleanup(failures) }
}, 155_000)

it.runIf(windowsNative)("keeps supervising while an open record delays crash publication", async () => {
  const f = supervisorFixture("domovoi-record-held-")
  let handle: number | undefined
  const failures: unknown[] = []
  try {
    await f.poll("first running attempt", () => readWindowsSupervisorRecord(f.home)?.state === "running" && existsSync(f.marker))
    const first = readWindowsSupervisorRecord(f.home)!, attempt = first.attempts[0]!
    handle = openSync(join(f.directory, "windows-supervisor.json"), "r")
    // Only kill the daemon. Its helper must close the job and report the crash
    // while the test's open target prevents replacement of the record.
    process.kill(attempt.child!.pid, "SIGKILL")
    await f.poll("daemon termination", () => queryWindowsProcess(attempt.child!.pid).identity?.start !== attempt.child!.start)
    await delay(1_500)
    // Prove the open handle blocked replacement; allowing rename would stop exercising this race.
    const held = readWindowsSupervisorRecord(f.home)
    expect(held).toMatchObject({ state: "running", crashes: 0, supervisorId: first.supervisorId })
    expect(held!.attempts).toHaveLength(1)
    closeSync(handle); handle = undefined
    await f.poll("second running attempt", () => {
      const record = readWindowsSupervisorRecord(f.home)
      return record?.state === "running" && record.supervisorId === first.supervisorId && record.attempts.length === 2 && record.crashes === 1
    })
    expect(f.ended()).toBe(false)
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
    await f.cleanup(failures)
  }
}, 155_000)
