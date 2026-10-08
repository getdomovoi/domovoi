import * as childProcess from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { claimExclusiveFileLease } from "../file-lease.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { readWindowsSupervisorRecord, writeSupervisorStopRequest } from "./supervisor-record.js"
import { runWindowsSupervisor } from "./windows-job-supervisor.js"
import { launchWindowsJob, windowsJobCommand } from "./windows-job.js"

// Only the helper command is substituted. The real execFileSync, with the
// production per-query cap, spawns the stand-in and kills it on timeout.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
vi.mock("./windows-job.js", async (original) => ({ ...await original<typeof import("./windows-job.js")>(), launchWindowsJob: vi.fn() }))

const bootId = "windows-boot:42"
const homes: string[] = []
beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "domovoi-windows-logon-")); homes.push(home)
  const directory = join(home, ".domovoi"), path = join(directory, "service.json")
  mkdirSync(directory, { mode: 0o700 })
  const config = { ...createServiceConfiguration({ DOMOVOI_PROFILE_DIR: directory }, { homeDirectory: home, workingDirectory: home, platform: process.platform }), registrationId: randomUUID() }
  writeFileSync(path, serializeServiceConfiguration(config), { mode: 0o600 })
  return { home, directory, path, config, lease: join(directory, "windows-supervisor-lease.sqlite") }
}

// The launched job is retired at once, so a successful start ends in a
// deliberate stop after exactly one launch.
function retireOnLaunch(f: ReturnType<typeof fixture>) {
  vi.mocked(launchWindowsJob).mockImplementation(async (input) => {
    writeSupervisorStopRequest({ profileDirectory: f.directory }, { registrationId: f.config.registrationId, supervisorId: randomUUID(), loop: { pid: process.pid, start: "456", bootId } })
    const receipt = { kind: "empty" as const, job: input.job, bootId, activeProcesses: 0 as const, terminated: true as const, code: 1, stopped: true }
    return { prepared: { kind: "prepared", job: input.job, bootId, child: { pid: 322, start: "1", bootId }, helper: { pid: 323, start: "2", bootId }, killOnClose: true, stdioOnly: true },
      resume: async () => {}, exited: new Promise(() => {}), stop: async () => receipt }
  })
}

function asWindows() { vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } })) }
const helperPath = () => windowsJobCommand().command
const helperCalls = () => vi.mocked(childProcess.execFileSync).mock.calls.filter(([command]) => command === helperPath())
async function substituteHelper(run: (options: childProcess.ExecFileSyncOptions) => string) {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  vi.mocked(childProcess.execFileSync).mockImplementation(((command: string, args: readonly string[], options: childProcess.ExecFileSyncOptions) =>
    command === helperPath() ? run(options) : actual.execFileSync(command, args, options)) as typeof childProcess.execFileSync)
  return actual
}

it("starts after its first helper query outlives the per-query cap at a cold logon", async () => {
  const f = fixture()
  const marker = join(f.home, "first-call")
  // The first call sleeps past the 20 s cap, as a cold Windows PowerShell host
  // and compile did in CI; every later call answers like the warm helper.
  const standIn = `const fs=require('node:fs');const marker=process.argv[1];
if(!fs.existsSync(marker)){fs.writeFileSync(marker,'cold');setTimeout(()=>{},60000)}else{let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{input+=chunk});process.stdin.on('end',()=>{const request=JSON.parse(input);
process.stdout.write(JSON.stringify({bootId:${JSON.stringify(bootId)},identities:request.pids.map((pid)=>({pid,start:'456',bootId:${JSON.stringify(bootId)}}))}))})}`
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  await substituteHelper((options) => actual.execFileSync(process.execPath, ["-e", standIn, marker], { ...options, encoding: "utf8" }))
  retireOnLaunch(f)
  asWindows()
  const began = performance.now()
  const record = await runWindowsSupervisor(f.path, { executable: "unused", args: [] })
  expect(readFileSync(marker, "utf8")).toBe("cold")
  expect(performance.now() - began).toBeGreaterThanOrEqual(20_000)
  expect(helperCalls()).toHaveLength(2)
  expect(helperCalls()[0]![2]).toMatchObject({ timeout: 20_000 })
  expect(record).toMatchObject({ state: "stopped", reason: "deliberate-stop", loop: { pid: process.pid, start: "456", bootId } })
  expect(launchWindowsJob).toHaveBeenCalledOnce()
}, 60_000)

const timedOut = () => Object.assign(new Error(`spawnSync ${helperPath()} ETIMEDOUT`), { code: "ETIMEDOUT", errno: -4039, signal: "SIGTERM", status: null })

it("fails closed with a stated reason when the retried first query also times out", async () => {
  const f = fixture()
  await substituteHelper(() => { throw timedOut() })
  retireOnLaunch(f)
  asWindows()
  const failure = await runWindowsSupervisor(f.path, { executable: "unused", args: [] }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toMatch(/^Windows supervisor could not read its own process identity/)
  expect((failure as Error).message).toContain("No daemon was launched")
  expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe("ETIMEDOUT")
  expect(helperCalls()).toHaveLength(2)
  expect(launchWindowsJob).not.toHaveBeenCalled()
  expect(readWindowsSupervisorRecord(f.home)).toBeUndefined()
  // The startup lease is released for the next logon's supervisor.
  claimExclusiveFileLease(f.lease, () => new Error("lease still held")).release()
  expect(existsSync(f.lease)).toBe(true)
})

it("does not retry a first query that fails for a reason other than its time cap", async () => {
  const f = fixture()
  await substituteHelper(() => { throw new Error("Access denied") })
  retireOnLaunch(f)
  asWindows()
  await expect(runWindowsSupervisor(f.path, { executable: "unused", args: [] })).rejects.toThrow("Access denied")
  expect(helperCalls()).toHaveLength(1)
  expect(launchWindowsJob).not.toHaveBeenCalled()
  expect(readWindowsSupervisorRecord(f.home)).toBeUndefined()
})
