import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, stat } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { readLocalOwnerRecord } from "../local-owner-record.js"
import { withinServiceDeadline } from "./deadline.js"
import { createServiceConfiguration, parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { installService, nodeServiceEffects, removeService, runServiceCommand, serviceStatus, type ServiceCommand, type ServiceEffects } from "./install.js"
import { disableWindowsTask, stopWindowsTask, windowsPowerShellPath, windowsSchtasksPath, windowsTaskRemovalPlan } from "./windows-task.js"
import { updateDaemonService } from "./desktop-service.js"
import { readSupervisorStopRequest, readWindowsSupervisorRecord, type WindowsSupervisorRecord } from "./supervisor-record.js"
import { stopWindowsSupervisor } from "./windows-job-supervisor.js"
import { queryWindowsProcess, queryWindowsProcesses } from "./windows-job.js"
import { removeScratchDirectory } from "../test-scratch.js"
import { nativeServiceTestsEnabled } from "../test-native-service-gate.js"

// Real 1/5/15 second backoffs plus Windows compiler, manager and startup time.
// No test speed knob is exposed in the production configuration.
const lifecycleBudget = 180_000
const cleanupBudget = 60_000
// Carved out of cleanupBudget, so a stop step that spends its whole slice
// still leaves the removal time of its own.
const removalBudget = 20_000
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const powershell = (script: string): ServiceCommand => ({ command: windowsPowerShellPath(),
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] })

// These tests register a real logon task for whoever runs them, and an
// interrupted run leaves it registered. They run on CI and, on a developer
// machine, only with DOMOVOI_NATIVE_SERVICE_TESTS=1.
const windowsNative = process.platform === "win32" && nativeServiceTestsEnabled("Windows")

it.runIf(windowsNative).each(["exhaustion", "stop", "unstarted"] as const)("proves native Windows supervised %s and removal", async (mode) => {
  const name = `Domovoi-supervision-test-${randomUUID()}`
  const deadline = OperationDeadline.start(lifecycleBudget)
  const base = await mkdtemp(join(tmpdir(), "domovoi-task-"))
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
  // Exceed the former command limit without needlessly lengthening SQLite paths.
  const shortCommand = `"${process.execPath}" "${entry}" --service-supervise "${serviceConfigurationPath(base, "win32")}"`
  const directory = join(base, "h".repeat(Math.max(1, 280 - shortCommand.length)))
  const profile = { profileDirectory: join(directory, "profile") }
  const path = serviceConfigurationPath(directory, "win32")
  const effects = nodeServiceEffects({ userHomeDirectory: directory })
  const plan = windowsTaskRemovalPlan(name)
  let created = false, started = false, removed = false
  const failures: unknown[] = []
  // Phase timings go to the CI log as each phase ends, so a run that reaches
  // its deadline still shows where the time went. They assert nothing.
  const began = performance.now()
  let lastMark = began
  const timing = (phase: string) => {
    const now = performance.now()
    console.log(`[windows supervision ${mode}] ${phase}: ${Math.round(now - lastMark)} ms (elapsed ${Math.round(now - began)} ms)`)
    lastMark = now
  }
  const capture = (command: ServiceCommand, active = deadline) => withinServiceDeadline(active,
    () => effects.capture(command.command, command.args, active))
  const poll = async (test: () => boolean, observe?: () => void) => {
    while (!test()) { observe?.(); deadline.throwIfExpired(); await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal })) }
  }
  const record = () => readWindowsSupervisorRecord(profile)
  // Splits a wait for attempt n into the supervisor stages the record shows:
  // the previous job's exit proof, launch intent, prepared job, and resumed
  // job. The remainder, after the last stage, is daemon readiness. Timing is
  // diagnostic only: a failed extra read is skipped, never fails the poll.
  const stages = (attempt: number) => {
    const seen = new Set<string>()
    return () => {
      let state: WindowsSupervisorRecord | undefined
      try { state = record() } catch { return }
      const mark = (stage: string, reached: boolean | undefined) => {
        if (reached && !seen.has(stage)) { seen.add(stage); timing(`attempt ${attempt} ${stage}`) }
      }
      // The supervisor records the exit proof and its backoff in one write.
      mark("previous exit proven", attempt > 1 && !!state?.attempts[attempt - 2]?.empty)
      const current = state?.attempts[attempt - 1]
      mark("launch intent recorded", !!current)
      mark("job prepared", current && current.stage !== "intent")
      mark("job resumed", state?.attempts.length === attempt && state.state === "running")
    }
  }
  // Each record is read on its own, so one unreadable file keeps the other.
  const describeRecord = () => {
    let supervisor: unknown, owner: unknown
    try {
      const state = record()
      supervisor = state && { state: state.state, reason: state.reason, crashes: state.crashes, updatedAt: state.updatedAt,
        attempts: state.attempts.map((a) => ({ number: a.number, stage: a.stage, startedAt: a.startedAt, emptyAt: a.empty?.at ?? null,
          exitCode: a.exitCode, backoffMs: a.backoffMs })) }
    } catch (error) { supervisor = `unreadable: ${String(error)}` }
    try { owner = readLocalOwnerRecord(profile)?.state ?? null } catch (error) { owner = `unreadable: ${String(error)}` }
    return JSON.stringify({ supervisor, owner })
  }
  const readyInstance = () => {
    const owner = readLocalOwnerRecord(profile)
    if (owner?.state !== "ready") throw new Error("Expected a ready daemon owner")
    return owner.instanceId
  }
  const running = (attempt: number, previousInstance?: string) => {
    const state = record()
    const owner = readLocalOwnerRecord(profile)
    return state?.state === "running" && state.attempts.length === attempt && owner?.state === "ready"
      && owner.instanceId !== previousInstance
  }
  // Redirect every manager call to this UUID task. The unstarted case also
  // fails the demand start, after the real installer has registered the task.
  // All helper, record, status-handler and removal paths remain real.
  const renamed = ({ command, args }: ServiceCommand): ServiceCommand => {
    if (command === windowsSchtasksPath() && args[0] === "/run" && args[1] === "/tn" && args[2] === "Domovoi daemon") {
      return { command, args: ["/run", "/tn", name] }
    }
    if (command !== windowsPowerShellPath()) throw new Error("Unexpected manager command")
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
    const named = `$name = ${literal("Domovoi daemon")}`
    if (!script.includes(named)) throw new Error("Refusing a command outside the UUID task")
    return powershell(script.replace(named, `$name = ${literal(name)}`))
  }
  const scoped: ServiceEffects = { ...effects,
    capture: (command, args, active) => capture(renamed({ command, args }), active),
    run: async (command, args, active) => {
      const named = renamed({ command, args })
      if (command === windowsSchtasksPath() && args[0] === "/run") {
        if (mode === "unstarted") throw new Error("Injected failure before demand start")
        started = true
      }
      await effects.run(named.command, named.args, active)
    },
  }
  const killDaemon = (state: WindowsSupervisorRecord) => {
    const child = state.attempts.at(-1)?.child
    expect(child).not.toBeNull()
    process.kill(child!.pid, "SIGKILL")
  }
  try {
    expect(await capture(plan.inspect)).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
    timing("task absent before install")
    await mkdir(profile.profileDirectory, { recursive: true })
    const configuration = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: profile.profileDirectory, DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0" },
      { platform: "win32", homeDirectory: directory, workingDirectory: directory })
    expect(`"${process.execPath}" "${entry}" --service-supervise "${path}"`.length).toBeGreaterThan(261)
    created = true
    const install = installService({ platform: "win32", home: directory, user: userInfo().username,
      execPath: entry, runtime: process.execPath, configuration }, scoped)
    // installService always requests a start. Fail that boundary to retain the
    // never-launched registration while exercising its real writes and register.
    if (mode === "unstarted") await expect(install).rejects.toThrow("Injected failure before demand start")
    else expect(await install).toMatchObject({ kind: "task" })
    const config = parseServiceConfiguration(readFileSync(path, "utf8"))
    expect(config.serviceRuntime).toEqual({ executable: process.execPath, entry })
    expect(config.registrationId).toBeDefined()
    timing("install: task registered")
    const xml = await capture({ command: windowsSchtasksPath(), args: ["/query", "/tn", name, "/xml"] })
    expect(xml.code).toBe(0)
    // schtasks may emit UTF-16 through its redirected output. These three XML
    // values are ASCII and their assertion is independent of its BOM.
    const settings = xml.stdout.replaceAll("\0", "")
    expect(settings).toMatch(/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
    expect(settings).toMatch(/<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/)
    expect(settings).toMatch(/<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/)
    timing("install: settings applied and read back")
    if (mode === "unstarted") {
      expect(record()).toBeUndefined()
      expect(existsSync(join(profile.profileDirectory, "windows-supervisor-lease.sqlite"))).toBe(false)
      await removeService({ platform: "win32", home: directory }, scoped)
      timing("removal")
      expect(record()).toMatchObject({ state: "stopped", attempts: [] })
      expect(existsSync(path)).toBe(false)
      expect(await capture(plan.inspect)).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
      removed = true
      timing("absent after removal")
      return
    }
    expect(started).toBe(true)
    timing("task started by install")
    await poll(() => running(1), stages(1))
    timing("attempt 1 daemon ready")
    const first = record()!
    expect(await serviceStatus({ platform: "win32", home: directory }, scoped)).toMatchObject({ installed: true, running: true })
    timing("status: running")
    if (mode === "exhaustion") {
      const firstInstance = readyInstance()
      killDaemon(first)
      timing("crash 1: daemon killed")
      await poll(() => running(2, firstInstance), stages(2))
      timing("attempt 2 daemon ready")
      const second = record()!
      expect(second.attempts[1]!.child!.pid).not.toBe(first.attempts[0]!.child!.pid)
      expect(second.attempts[0]!.empty).toMatchObject({ activeProcesses: 0, terminated: true })
      await withinServiceDeadline(deadline, () => delay(3_000, undefined, { signal: deadline.signal }))
      expect(record()).toMatchObject({ state: "running", crashes: 1 })
      expect(record()!.attempts).toHaveLength(2)
      expect(record()!.attempts[1]!.child!.pid).toBe(second.attempts[1]!.child!.pid)
      timing("attempt 2 held for 3 s")
      for (const next of [3, 4]) {
        const previousInstance = readyInstance()
        killDaemon(record()!)
        timing(`crash ${next - 1}: daemon killed`)
        await poll(() => running(next, previousInstance), stages(next))
        timing(`attempt ${next} daemon ready`)
      }
      killDaemon(record()!)
      timing("crash 4: daemon killed")
      await poll(() => record()?.state === "exhausted")
      timing("exhaustion recorded")
      expect(record()!.attempts).toHaveLength(4)
      const stdout = vi.fn(), stderr = vi.fn()
      // This is the production CLI handler's exit code, with only the manager
      // task name redirected. No default user task or profile is queried.
      expect(await runServiceCommand(["service", "status"], { ...scoped, platform: "win32", home: directory,
        execPath: entry, runtime: process.execPath, environment: { DOMOVOI_PROFILE_DIR: profile.profileDirectory }, stdout, stderr })).toBe(1)
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("supervision exhausted after 4 crashes"))
      expect(stderr).not.toHaveBeenCalled()
      timing("status: exhausted")
    } else {
      const runtime = { nodePath: process.execPath, daemonEntryPath: entry }
      const dependencies = { ...scoped, platform: "win32", home: directory, user: userInfo().username,
        runtimeFile: async (file: string) => (await stat(file)).isFile() ? "file" as const : "not-file" as const }
      const oldInstance = readyInstance()
      expect(await updateDaemonService({ runtime }, dependencies)).toMatchObject({ kind: "task" })
      expect(readyInstance()).not.toBe(oldInstance)
      expect(await serviceStatus({ platform: "win32", home: directory }, scoped)).toMatchObject({ installed: true, running: true })
      timing("update: new instance ready")
      const updatedInstance = readyInstance()
      let failStart = true
      await expect(updateDaemonService({ runtime }, { ...dependencies, run: async (command, args, active) => {
        if (args[0] === "/run" && failStart) { failStart = false; throw new Error("Injected demand-start failure") }
        await scoped.run(command, args, active)
      } })).rejects.toMatchObject({ outcome: "swap-failed-restored" })
      expect(readyInstance()).not.toBe(updatedInstance)
      expect(await serviceStatus({ platform: "win32", home: directory }, scoped)).toMatchObject({ installed: true, running: true })
      timing("update rollback: restored instance ready")
      await disableWindowsTask(plan, effects, deadline)
      await stopWindowsSupervisor(path, deadline, { retire: false, stopTask: async () => {
        expect(readSupervisorStopRequest(profile)?.registrationId).toBe(config.registrationId)
        return await stopWindowsTask(plan, effects, deadline) === "stopped"
      } })
      timing("supervisor stopped")
      expect(readSupervisorStopRequest(profile)).toBeUndefined()
      expect(record()).toMatchObject({ state: "stopped", reason: "deliberate-stop" })
      await withinServiceDeadline(deadline, () => delay(3_000, undefined, { signal: deadline.signal }))
      expect(record()!.attempts).toHaveLength(1)
      expect(queryWindowsProcess(first.attempts[0]!.child!.pid).identity).not.toEqual(first.attempts[0]!.child)
      timing("stopped held for 3 s")
    }
    await removeService({ platform: "win32", home: directory }, scoped)
    timing("removal")
    expect(record()!.attempts.every((a) => a.empty?.activeProcesses === 0 && a.empty.terminated)).toBe(true)
    const children = record()!.attempts.map((attempt) => attempt.child!)
    const observed = queryWindowsProcesses(children.map((child) => child.pid))
    children.forEach((child, index) => expect(observed.identities[index]).not.toEqual(child))
    expect(await capture(plan.inspect)).toMatchObject({ code: 0, stdout: "domovoi-task:missing\r\n" })
    removed = true
    timing("daemon trees and task absent after removal")
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    if (!removed) {
      timing(`not completed; record ${describeRecord()}`)
      // The supervised daemon's own output names why an attempt exited early.
      let output: string
      try { output = readFileSync(join(profile.profileDirectory, "windows-daemon.log"), "utf8").slice(-4_000) }
      catch (error) { output = `unreadable: ${String(error)}` }
      console.log(`[windows supervision ${mode}] daemon output tail:\n${output}`)
    }
    // Each step runs whatever the steps before it did, so a disable, stop or
    // supervisor wait that fails never skips the removal of the logon task.
    const failed: unknown[] = []
    const step = async (work: () => Promise<unknown>) => {
      try { await work() } catch (error) { failed.push(error) }
    }
    let absent = !created || removed
    if (!absent) {
      const stopping = OperationDeadline.start(cleanupBudget - removalBudget)
      try {
        await step(() => capture(plan.disable!, stopping))
        if (started) await step(() => stopWindowsSupervisor(path, stopping))
        await step(async () => expect((await capture(plan.stop, stopping)).code).toBe(0))
      } finally { stopping.clear() }
      const removal = OperationDeadline.start(removalBudget)
      try {
        await step(async () => {
          const present = await capture(plan.inspect, removal)
          if (present.stdout.trim() !== "domovoi-task:missing") expect((await capture(plan.remove, removal)).code).toBe(0)
        })
        // The plan's removal refuses a task that is not disabled and stopped.
        // schtasks /delete /f does not, so a stop step that failed above still
        // leaves no logon task registered in this account.
        await step(async () => {
          let present = await capture(plan.inspect, removal)
          if (present.stdout.trim() !== "domovoi-task:missing") {
            await capture({ command: windowsSchtasksPath(), args: ["/delete", "/tn", name, "/f"] }, removal)
            present = await capture(plan.inspect, removal)
          }
          if (present.code !== 0 || present.stdout.trim() !== "domovoi-task:missing") throw new Error(`Task Scheduler still lists ${name}`)
          absent = true
        })
      } finally { removal.clear() }
    }
    // The directory holds the task's configuration, so it goes only once the
    // task is gone. A task still registered keeps it for inspection.
    if (absent) await step(() => removeScratchDirectory(base))
    timing("cleanup")
    if (failed.length > 0) {
      const recovery = absent ? "" : ` If schtasks /query /tn "${name}" still answers, run schtasks /delete /tn "${name}" /f, then remove ${base}.`
      // Thrown from the finally, this replaces the body's own failure, so that
      // failure travels inside it.
      // eslint-disable-next-line no-unsafe-finally
      throw new AggregateError([...failures, ...failed], `Native Windows task cleanup for ${name} did not complete.${recovery}`)
    }
  }
}, lifecycleBudget + cleanupBudget + 1_000)
