import { randomUUID } from "node:crypto"
import { win32 } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { expect, it } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { localOwnerRecordSchema, type ReadyLocalOwner } from "../local-owner-record.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { nodeServiceEffects, type ServiceCommand } from "./install.js"
import { supervisorRecordSchema, type SupervisorRecord } from "./supervisor-record.js"
import { removeWindowsTask, windowsPowerShellPath } from "./windows-task.js"
import { wslTaskPlan } from "./wsl-task.js"
import { captureWslTaskAction, wslTaskActionProbe } from "./wsl-task-action-probe.js"
import { observeWslTaskReadiness, wslGuestReadinessSnapshotScript, wslTaskFixtureBudgets } from "./wsl-task-test-support.js"

const node = "/opt/domovoi-ci-node/bin/node"
const daemon = "/opt/domovoi-ci-daemon/dist/index.js"
const distribution = process.env["DOMOVOI_WSL_REQUIRED_DISTRIBUTION"]
const required = process.env["DOMOVOI_WSL_NATIVE_SERVICE"] === "1"
const budget = wslTaskFixtureBudgets(required ? process.env["DOMOVOI_WSL_NATIVE_SERVICE_BUDGET_MS"] : undefined)
const lifecycleBudget = budget.lifecycle
const cleanupBudget = budget.cleanup
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"

// The production supervisor inherits this preload into each daemon child.
// Inject one real ENOENT at spawn and use private self-signal requests for
// crashes: no test ever signals a saved PID that might have been reused.
const observer = [
  "import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';",
  "import childProcess from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const home = process.env.HOME;",
  "if (process.argv.includes('--service-supervise')) {",
  "  const spawn = childProcess.spawn;",
  "  childProcess.spawn = (executable, args, options) => {",
  "    try { unlinkSync(home + '/fail-launch'); executable = home + '/missing-node'; }",
  "    catch (e) { if (e.code !== 'ENOENT') throw e; }",
  "    return spawn(executable, args, options);",
  "  };",
  "  syncBuiltinESMExports();",
  "}",
  "if (process.argv.includes('--service-config')) {",
  "const request = home + '/request.json';",
  "const identity = { pid: process.pid, start: readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19] };",
  "writeFileSync(home + '/process.partial', JSON.stringify({ ...identity, executable: process.execPath, argv: process.argv, uid: process.getuid(), home, path: process.env.PATH, distribution: process.env.WSL_DISTRO_NAME }), { mode: 0o600 });",
  "renameSync(home + '/process.partial', home + '/process.json');",
  "setInterval(() => {",
  "  let value;",
  "  try { value = JSON.parse(readFileSync(request, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }",
  "  if (value.pid !== process.pid || value.start !== identity.start) return;",
  "  if (value.signal !== 'SIGKILL' && value.signal !== 'SIGTERM') throw new Error('Unknown fixture signal');",
  "  unlinkSync(request);",
  "  process.kill(process.pid, value.signal);",
  "}, 100).unref();",
  "}",
].join("\n")

type GuestIdentity = { pid: number; start: string }

it.runIf(process.platform === "win32" && required)(
  "propagates guest failure, restarts it, and removes only its WSL task",
  async () => {
    expect(distribution).toMatch(/^domovoi-ci-[0-9a-f-]{36}$/)
    const name = "Domovoi-WSL-test-" + randomUUID()
    let registrationId = randomUUID()
    const home = "/tmp/domovoi-wsl-task-" + randomUUID()
    const configPath = home + "/.domovoi/service.json"
    const powershell = windowsPowerShellPath()
    const wsl = win32.join(process.env.SystemRoot!, "System32", "wsl.exe")
    const effects = nodeServiceEffects()
    const deadline = OperationDeadline.start(lifecycleBudget)
    const guestEnvironment = ["HOME=" + home, "PATH=/opt/domovoi-ci-node/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
    const target = {
      name, registrationId, distribution: distribution!, linuxUser: "root",
      executable: "/usr/bin/env",
      args: [...guestEnvironment, node, "--import", home + "/observer.mjs", daemon, "--service-supervise", configPath],
      powershell, wsl,
    }
    let plan = wslTaskPlan(target)
    const bystander = wslTaskPlan({ ...target, name: name + "-other", registrationId: randomUUID() })
    let registered = false
    let taskStarted = false
    let bystanderRegistered = false
    let guestStaged = false
    let companion: GuestIdentity | undefined
    let failure: unknown
    let diagnosticsCollected = false
    let phase = "guest fixture preparation"
    const began = performance.now()
    const mark = (next: string) => {
      process.stdout.write("WSL service " + phase + ": " + Math.round(performance.now() - began) + "ms elapsed\n")
      phase = next
    }
    const launchRecord = (entry: Record<string, unknown>) => process.stdout.write("WSL service launch: "
      + JSON.stringify({ lifecycleElapsedMs: Math.round(performance.now() - began), ...entry }) + "\n")
    const capture = (command: ServiceCommand, active = deadline) =>
      withinServiceDeadline(active, () => effects.capture(command.command, command.args, active))
    const checked = async (command: ServiceCommand, active = deadline) => {
      const result = await capture(command, active)
      if (result.code !== 0) throw new Error(command.command + " exited " + result.code + ": " + result.stderr)
      return result.stdout.trim()
    }
    const guest = (script: string, args: string[] = [], active = deadline) =>
      checked({ command: wsl, args: ["--distribution", distribution!, "--user", "root", "--exec", node, "-e", script, ...args] }, active)
    const read = (path: string, active = deadline) => guest(
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", [path], active)
    const supervisor = async (active = deadline): Promise<SupervisorRecord | undefined> => {
      const text = await guest([
        "const fs = require('node:fs');",
        "try {",
        "  if (fs.statSync(process.argv[1]).size > 16384) throw new Error('Supervisor fixture record is oversized');",
        "  process.stdout.write(fs.readFileSync(process.argv[1], 'utf8'));",
        "} catch (e) { if (e.code !== 'ENOENT') throw e; process.stdout.write('null'); }",
      ].join("\n"), [home + "/.domovoi/supervisor.json"], active)
      return text === "null" ? undefined : supervisorRecordSchema.parse(JSON.parse(text))
    }
    const stopSupervisor = async (active = deadline) => supervisorRecordSchema.parse(JSON.parse(await checked({
      command: wsl, args: ["--distribution", distribution!, "--user", "root", "--exec",
        node, daemon, "--service-supervisor-stop", configPath],
    }, active)))
    const serviceStatus = () => capture({ command: wsl, args: ["--distribution", distribution!, "--user", "root",
      "--exec", "/usr/bin/env", ...guestEnvironment, node, daemon, "service", "status"] })
    const snapshot = async (active: OperationDeadline) => {
      diagnosticsCollected = true
      return JSON.parse(await guest(wslGuestReadinessSnapshotScript, [home], active))
    }
    const inspect = (script: string, active = deadline) => {
      // This read-only probe has the same private UUID name as the production
      // commands. No wildcard, localized status, or inferred absence.
      const text = [
        "$ErrorActionPreference = 'Stop'",
        "$scheduler = New-Object -ComObject 'Schedule.Service'",
        "$scheduler.Connect()",
        "$task = $scheduler.GetFolder('\\').GetTask(" + literal(name) + ")",
        script,
      ].join("\n")
      return checked({ command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-EncodedCommand", Buffer.from(text, "utf16le").toString("base64")] }, active)
    }
    const taskHistory = (active: OperationDeadline) => inspect([
      // Read existing history only. Enabling a host log is outside this fixture.
      "$log = 'Microsoft-Windows-TaskScheduler/Operational'",
      "$channel = Get-WinEvent -ListLog $log -ErrorAction Stop",
      "if (-not $channel.IsEnabled) { [ordered]@{ state = 'disabled' } | ConvertTo-Json -Compress; exit 0 }",
      "$path = [string]$task.Path",
      "if ($path -notmatch '^\\\\Domovoi-WSL-test-[0-9a-f-]{36}$') { throw 'Unexpected task history scope' }",
      "$query = \"*[EventData[Data[@Name='TaskName']='\" + $path + \"']]\"",
      "try { $events = @(Get-WinEvent -LogName $log -FilterXPath $query -MaxEvents 16 -ErrorAction Stop) }",
      "catch {",
      "  if ($_.FullyQualifiedErrorId -ne 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { throw }",
      "  $events = @()",
      "}",
      "$entries = @($events | ForEach-Object {",
      "  $xml = [xml]$_.ToXml(); $data = [ordered]@{}",
      "  foreach ($value in @($xml.Event.EventData.Data)) {",
      "    if (@('TaskName', 'ActionName', 'ResultCode', 'TaskInstanceId', 'EnginePID', 'ProcessID') -contains [string]$value.Name) {",
      "      $text = [string]$value.InnerText; $data[[string]$value.Name] = $text.Substring(0, [Math]::Min(256, $text.Length))",
      "    }",
      "  }",
      "  [ordered]@{ id = $_.Id; recordId = $_.RecordId; time = $_.TimeCreated.ToUniversalTime().ToString('o'); data = $data }",
      "})",
      "[ordered]@{ state = 'available'; events = $entries } | ConvertTo-Json -Depth 5 -Compress",
    ].join("\n"), active)
    const observe = async <T>(probe: () => Promise<T | undefined>, active = deadline): Promise<T> => {
      for (;;) {
        active.throwIfExpired()
        const value = await withinServiceDeadline(active, probe)
        if (value !== undefined) return value
        await withinServiceDeadline(active, () => delay(100, undefined, { signal: active.signal }))
      }
    }
    let lastRecorded = ""
    const observeSupervisor = (accept: (record: SupervisorRecord) => boolean) => observe(async () => {
      const record = await supervisor()
      if (!record) return undefined
      const text = JSON.stringify(record)
      if (text !== lastRecorded) { launchRecord({ event: "supervisor-record", record }); lastRecorded = text }
      return accept(record) ? record : undefined
    })
    const processIdentity = async (active = deadline, file = "/process.json"): Promise<GuestIdentity | undefined> => {
      const text = await guest([
        "const fs = require('node:fs');",
        "try { process.stdout.write(fs.readFileSync(process.argv[1], 'utf8')); }",
        "catch (e) { if (e.code !== 'ENOENT') throw e; process.stdout.write('null'); }",
      ].join("\n"), [home + file], active)
      const value: unknown = JSON.parse(text)
      if (value === null) return undefined
      if (typeof value !== "object" || !("pid" in value) || !("start" in value)
        || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || typeof value.start !== "string" || !/^[0-9]+$/.test(value.start)) throw new Error("Invalid guest process identity")
      return { pid: value.pid, start: value.start }
    }
    const alive = async (owned: GuestIdentity, active = deadline) => {
      const answer = await guest([
        "const fs = require('node:fs');",
        "let stat;",
        "try { stat = fs.readFileSync('/proc/' + process.argv[1] + '/stat', 'utf8').split(') ').at(-1).split(' '); }",
        "catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }",
        "process.stdout.write(String(!!stat && stat[19] === process.argv[2] && stat[0] !== 'Z'));",
      ].join("\n"), [String(owned.pid), owned.start], active)
      if (answer !== "true" && answer !== "false") throw new Error("Invalid guest liveness answer")
      return answer === "true"
    }
    const signal = (owned: GuestIdentity, value: "SIGTERM" | "SIGKILL", active = deadline) => guest([
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[1] + '/request.partial', process.argv[2], { mode: 0o600 });",
      "fs.renameSync(process.argv[1] + '/request.partial', process.argv[1] + '/request.json');",
    ].join("\n"), [home, JSON.stringify({ ...owned, signal: value })], active)
    const ready = (previous?: { process: GuestIdentity; owner: ReadyLocalOwner }, start = previous === undefined) => observeWslTaskReadiness({
      deadline, diagnosticsMs: budget.diagnostics,
      // Include Run in the observed operation: it may stall before any poll.
      ...(start ? { start: async () => {
        taskStarted = true
        const result = await checked(plan.start)
        expect(result).toMatch(/^domovoi-task:[234]$/)
        return result
      } } : {}),
      task: async (active) => {
        const value: unknown = JSON.parse(await inspect(
          "[ordered]@{ state = [int]$task.State; lastTaskResult = [long]$task.LastTaskResult; lastRunTime = ([datetime]$task.LastRunTime).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress", active))
        if (value === null || typeof value !== "object" || !("state" in value) || !("lastTaskResult" in value)
          || typeof value.state !== "number" || !Number.isInteger(value.state) || value.state < 0 || value.state > 4
          || typeof value.lastTaskResult !== "number" || !Number.isSafeInteger(value.lastTaskResult)
          || !("lastRunTime" in value) || typeof value.lastRunTime !== "string" || value.lastRunTime.length > 64
          || Number.isNaN(Date.parse(value.lastRunTime))) {
          throw new Error("Invalid task State, LastTaskResult or LastRunTime")
        }
        const state = { state: value.state, lastTaskResult: value.lastTaskResult, lastRunTime: value.lastRunTime }
        if (active === deadline) return state
        const [history] = await Promise.allSettled([(async () => JSON.parse(await taskHistory(active)))()])
        return { ...state, history: history.status === "fulfilled"
          ? { value: history.value } : { error: String(history.reason).slice(0, 4_096) } }
      },
      probe: async (report) => {
        report({ step: "process-sidecar", state: "reading" })
        const current = await processIdentity()
        report({ step: "process-sidecar", state: current ? "present" : "missing", ...current })
        if (!current) return undefined
        if (previous && current.pid === previous.process.pid && current.start === previous.process.start) {
          report({ step: "replacement-process", state: "waiting" })
          return undefined
        }
        report({ step: "owner-record", state: "reading" })
        const text = await guest([
          "const fs = require('node:fs');",
          "try { process.stdout.write(fs.readFileSync(process.argv[1], 'utf8')); }",
          "catch (e) { if (e.code !== 'ENOENT') throw e; process.stdout.write('null'); }",
        ].join("\n"), [home + "/.domovoi/local-owner.json"])
        const raw: unknown = JSON.parse(text)
        const owner = localOwnerRecordSchema.safeParse(raw)
        if (!owner.success) {
          report({ step: "owner-record", state: raw === null ? "missing" : "invalid" })
          return undefined
        }
        report({ step: "owner-record", state: owner.data.state,
          ...("serviceRegistrationId" in owner.data ? { serviceRegistrationId: owner.data.serviceRegistrationId } : {}) })
        if (owner.data.state !== "ready" || owner.data.serviceRegistrationId !== registrationId) return undefined
        if (previous && owner.data.instanceId === previous.owner.instanceId) {
          report({ step: "replacement-owner", state: "waiting" })
          return undefined
        }
        report({ step: "process-liveness", state: "reading" })
        const running = await alive(current)
        report({ step: "process-liveness", state: running ? "alive" : "exited" })
        if (!running) throw new Error("Guest daemon exited before readiness")
        const record = await supervisor()
        if (!record || record.state !== "running") return undefined
        const child = record.attempts.at(-1)?.child
        if (!child || child.pid !== current.pid || child.start !== current.start) return undefined
        report({ step: "supervisor-record", supervisorId: record.supervisorId,
          loop: record.loop, attemptCount: record.attemptCount, crashes: record.crashes })
        return { process: current, owner: owner.data, supervisor: record }
      },
      snapshot,
      record: (entry) => process.stdout.write("WSL service readiness: " + JSON.stringify({
        phase, lifecycleElapsedMs: Math.round(performance.now() - began), ...entry,
      }) + "\n"),
    })
    const proveStopped = async (record: SupervisorRecord, active = deadline) => {
      for (const owned of [record.loop, ...record.attempts.flatMap((attempt) => attempt.child ? [attempt.child] : [])]) {
        expect(await alive(owned, active)).toBe(false)
      }
    }
    const taskRunTime = () => inspect("([datetime]$task.LastRunTime).ToUniversalTime().ToString('o')")
    const waitForTaskExit = (code: number) => observe(async () => {
      const state = JSON.parse(await inspect(
        "[ordered]@{ state = [int]$task.State; result = [long]$task.LastTaskResult } | ConvertTo-Json -Compress"))
      if (state.state === 2 || state.state === 4) return undefined
      expect(state.state).toBe(3)
      expect(state.result).toBe(code)
      return true
    })
    try {
      expect(await checked(plan.inspect)).toBe("domovoi-task:missing")
      // Set cleanup obligation before the first mutating call, including a
      // late completion after cancellation. All paths live in this UUID guest.
      guestStaged = true
      const configuration = {
        ...createServiceConfiguration({ DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0" },
          { platform: "linux", homeDirectory: home, workingDirectory: home }),
        registrationId,
      }
      await guest([
        "const fs = require('node:fs');",
        "const home = process.argv[1];",
        "fs.mkdirSync(home, { mode: 0o700 });",
        "fs.mkdirSync(home + '/.domovoi', { mode: 0o700 });",
        "fs.writeFileSync(home + '/observer.mjs', process.argv[2], { mode: 0o600, flag: 'wx' });",
        "fs.writeFileSync(home + '/.domovoi/service.json', process.argv[3], { mode: 0o600, flag: 'wx' });",
        "fs.writeFileSync(home + '/fail-launch', '', { mode: 0o600, flag: 'wx' });",
        "const child = require('node:child_process').spawn(process.execPath, ['-e', process.argv[4], home], { detached: true, stdio: 'ignore' });",
        "child.unref();",
      ].join("\n"), [home, observer, serializeServiceConfiguration(configuration), [
        "const fs = require('node:fs'), home = process.argv[1];",
        "fs.writeFileSync(home + '/companion.partial', JSON.stringify({ pid: process.pid, start: fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19] }), { mode: 0o600 });",
        "fs.renameSync(home + '/companion.partial', home + '/companion.json');",
        "setInterval(() => { if (fs.existsSync(home + '/companion.stop')) process.exit(0); }, 100);",
        "setTimeout(() => process.exit(0), " + budget.phase + ");",
      ].join("\n")])
      companion = await observe(() => processIdentity(deadline, "/companion.json"))
      expect(await alive(companion)).toBe(true)
      const boot = await read("/proc/sys/kernel/random/boot_id")
      const wslConfig = await read("/etc/wsl.conf")
      const configBefore = await read(configPath)
      // Compare Node's ordinary argv launch with the task's serialized string.
      // These controls run in the invoking host context, not Task Scheduler's.
      // Build before the optional capture: an invalid fixture is a test defect,
      // not an unavailable host observation to hide for another four minutes.
      const probe = wslTaskActionProbe(target, { runtime: node, environment: guestEnvironment, files: [
        { path: target.executable, executable: true }, { path: node, executable: true },
        { path: daemon, executable: false }, { path: home + "/observer.mjs", executable: false },
      ] })
      const controls = OperationDeadline.start(Math.min(10_000, deadline.remainingMs()), { signal: deadline.signal })
      try {
        const ordinary = await guest(probe.script, probe.argv, controls)
        launchRecord({ event: "ordinary-argv-control", context: "invoking host", value: JSON.parse(ordinary) })
        for (const variant of probe.variants) {
          launchRecord({ event: "verbatim-control-start", context: "invoking host", variant: variant.name, ...variant.action })
          const result = await captureWslTaskAction(variant.action, controls)
          launchRecord({ event: "verbatim-control-result", context: "invoking host", variant: variant.name, ...result })
        }
      } catch (error) {
        launchRecord({ event: "control-unavailable", error: String(error).slice(0, 4_096) })
      } finally { controls.clear() }
      mark("task registration")
      registered = true
      expect(await checked(plan.register)).toBe("domovoi-task:created")
      bystanderRegistered = true
      expect(await checked(bystander.register)).toBe("domovoi-task:created")
      expect(await checked(bystander.disable)).toBe("domovoi-task:1")
      const settings = JSON.parse(await inspect([
        "function Resolve-FixtureSid([string]$userId) {",
        "try { [System.Security.Principal.SecurityIdentifier]::new($userId).Value }",
        "catch { ([System.Security.Principal.NTAccount]::new($userId).Translate([System.Security.Principal.SecurityIdentifier])).Value }",
        "}",
        "$d = $task.Definition",
        "[ordered]@{ logonType = [int]$d.Principal.LogonType; runLevel = [int]$d.Principal.RunLevel;",
        "triggers = @($d.Triggers | ForEach-Object { [int]$_.Type }); userSid = (Resolve-FixtureSid $d.Principal.UserId);",
        "triggerUserSid = (Resolve-FixtureSid $d.Triggers.Item(1).UserId); currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
        "interval = $d.Settings.RestartInterval;",
        "retries = $d.Settings.RestartCount; limit = $d.Settings.ExecutionTimeLimit;",
        "instances = [int]$d.Settings.MultipleInstances; path = $d.Actions.Item(1).Path } | ConvertTo-Json -Compress",
      ].join("\n")))
      expect(settings).toMatchObject({ logonType: 3, runLevel: 0, triggers: [9],
        retries: 0, limit: "PT0S", instances: 2, path: wsl })
      expect(settings.userSid).toBe(settings.currentUserSid)
      expect(settings.triggerUserSid).toBe(settings.currentUserSid)
      launchRecord({ event: "registered-action", value: JSON.parse(await inspect([
        "[ordered]@{ path = $task.Definition.Actions.Item(1).Path; arguments = $task.Definition.Actions.Item(1).Arguments;",
        "workingDirectory = $task.Definition.Actions.Item(1).WorkingDirectory; userId = $task.Definition.Principal.UserId;",
        "lastRunTime = ([datetime]$task.LastRunTime).ToUniversalTime().ToString('o');",
        "host = [ordered]@{ userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
        "is64Bit = [Environment]::Is64BitProcess; WSL_UTF8 = $env:WSL_UTF8; WSLENV = $env:WSLENV } } | ConvertTo-Json -Depth 3 -Compress",
      ].join("\n"))), expectedAction: plan.action, wslConfig })
      mark("failed launch and first guest recovery")
      const first = await ready()
      const runTime = await taskRunTime()
      expect(first.supervisor).toMatchObject({ attemptCount: 2, crashes: 1 })
      expect(first.supervisor.attempts[0]).toMatchObject({
        child: null, exit: { kind: "launch-failed", errorCode: "ENOENT" }, backoffMs: 1000, backoffOutcome: "completed",
      })
      let previous = first
      for (const attempt of [3, 4]) {
        mark("SIGKILL recovery to attempt " + attempt)
        await signal(previous.process, "SIGKILL")
        const next = await ready(previous)
        expect(next.owner.instanceId).not.toBe(previous.owner.instanceId)
        expect(next.owner.machineId).toBe(first.owner.machineId)
        expect(next.supervisor.supervisorId).toBe(first.supervisor.supervisorId)
        expect(next.supervisor.loop).toEqual(first.supervisor.loop)
        expect(next.supervisor.attemptCount).toBe(attempt)
        expect(await taskRunTime()).toBe(runTime)
        previous = next
      }
      expect(await checked(plan.inspect)).toBe("domovoi-task:4")
      mark("fourth crash and loud exhaustion")
      await signal(previous.process, "SIGKILL")
      const exhausted = await observeSupervisor((record) => record.state === "exhausted")
      expect(exhausted).toMatchObject({ attemptCount: 4, crashes: 4, reason: { kind: "restart-limit" } })
      expect(exhausted.attempts.slice(1).map((attempt) => attempt.exit?.signal)).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"])
      expect(exhausted.attempts.map((attempt) => attempt.backoffMs)).toEqual([1000, 5000, 15000, 0])
      for (let index = 0; index < 3; index++) {
        const attempt = exhausted.attempts[index]!
        const next = exhausted.attempts[index + 1]!
        expect(attempt.backoffOutcome).toBe("completed")
        // Actual guest wall-clock measurements, not just the configured delay.
        expect(Date.parse(attempt.backoffEndedAt!) - Date.parse(attempt.exit!.at)).toBeGreaterThanOrEqual(attempt.backoffMs)
        expect(Date.parse(next.startedAt)).toBeGreaterThanOrEqual(Date.parse(attempt.backoffEndedAt!))
      }
      expect(await taskRunTime()).toBe(runTime)
      await waitForTaskExit(1)
      await proveStopped(exhausted)
      const exhaustedStatus = await serviceStatus()
      expect(exhaustedStatus.code).toBe(1)
      expect(exhaustedStatus.stdout).toContain("stopped; supervision exhausted after 4 crashes; last exit signal SIGKILL at " + exhausted.attempts[3]!.exit!.at)

      mark("explicit new lifetime and clean exit")
      const clean = await ready(previous, true)
      expect(clean.supervisor.supervisorId).not.toBe(exhausted.supervisorId)
      expect(clean.supervisor.attemptCount).toBe(1)
      await signal(clean.process, "SIGTERM")
      const cleanExit = await observeSupervisor((record) => record.state === "stopped")
      expect(cleanExit).toMatchObject({ attemptCount: 1, crashes: 0, reason: { kind: "clean-exit" } })
      expect(cleanExit.attempts[0]).toMatchObject({ exit: { kind: "clean", code: 0 }, backoffMs: 0, backoffOutcome: null })
      await waitForTaskExit(0)
      await proveStopped(cleanExit)

      mark("deliberate removal during a live child")
      const live = await ready(clean, true)
      expect(await checked(plan.disable)).toMatch(/^domovoi-task:[14]$/)
      const liveStop = await stopSupervisor()
      expect(liveStop).toMatchObject({ supervisorId: live.supervisor.supervisorId, state: "stopped",
        attemptCount: 1, crashes: 0, reason: { kind: "deliberate-stop" } })
      expect(liveStop.attempts[0]!.exit?.kind).toBe("stopped")
      await proveStopped(liveStop)
      expect(await removeWindowsTask(plan.removal, effects, deadline)).toBe("removed")
      expect(await checked(plan.inspect)).toBe("domovoi-task:missing")
      registered = false
      taskStarted = false
      expect(await read(configPath)).toBe(configBefore)

      // Removal retires a registration. Reinstall explicitly with a fresh ID;
      // never erase its stop request to restart the removed lifetime.
      mark("reinstall for removal during backoff")
      registrationId = randomUUID()
      configuration.registrationId = registrationId
      const reinstalledConfig = serializeServiceConfiguration(configuration)
      await guest([
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv[1] + '.partial', process.argv[2], { mode: 0o600 });",
        "fs.renameSync(process.argv[1] + '.partial', process.argv[1]);",
      ].join("\n"), [configPath, reinstalledConfig])
      plan = wslTaskPlan({ ...target, registrationId })
      registered = true
      expect(await checked(plan.register)).toBe("domovoi-task:created")
      let backoffChild = await ready(live, true)
      for (let crash = 1; crash <= 2; crash++) {
        await signal(backoffChild.process, "SIGKILL")
        backoffChild = await ready(backoffChild)
      }
      await signal(backoffChild.process, "SIGKILL")
      const backingOff = await observeSupervisor((record) => record.state === "backoff" && record.crashes === 3)
      expect(backingOff.attempts[2]).toMatchObject({ backoffMs: 15000, backoffOutcome: null })
      expect(await checked(plan.disable)).toMatch(/^domovoi-task:[14]$/)
      const backoffStop = await stopSupervisor()
      expect(backoffStop).toMatchObject({ supervisorId: backingOff.supervisorId, state: "stopped",
        attemptCount: 3, crashes: 3, reason: { kind: "deliberate-stop" } })
      expect(backoffStop.attempts[2]).toMatchObject({ backoffMs: 15000, backoffOutcome: "cancelled" })
      await proveStopped(backoffStop)
      expect(await removeWindowsTask(plan.removal, effects, deadline)).toBe("removed")
      expect(await checked(plan.inspect)).toBe("domovoi-task:missing")
      registered = false
      taskStarted = false
      // Distro, host config, private profile, bystander and companion survive.
      expect(await read("/proc/sys/kernel/random/boot_id")).toBe(boot)
      expect(await read("/etc/wsl.conf")).toBe(wslConfig)
      expect(await read(configPath)).toBe(reinstalledConfig.trim())
      expect(await alive(companion)).toBe(true)
      expect(await checked(bystander.inspect)).toBe("domovoi-task:1")
      mark("complete")
    } catch (cause) {
      failure = new Error("WSL service proof failed during " + phase, { cause })
      if (!diagnosticsCollected && guestStaged) {
        const diagnostics = OperationDeadline.start(budget.diagnostics)
        try {
          const [guestResult, taskResult] = await Promise.allSettled([snapshot(diagnostics), taskHistory(diagnostics)])
          const result = (value: PromiseSettledResult<unknown>) => value.status === "fulfilled"
            ? { value: value.value } : { error: String(value.reason).slice(0, 4096) }
          launchRecord({ event: "failure-diagnostics", guest: result(guestResult), task: result(taskResult) })
        } finally { diagnostics.clear() }
      }
    } finally {
      deadline.clear()
      const cleanup = OperationDeadline.start(cleanupBudget)
      const failures: unknown[] = []
      // Guest death must precede task deletion. Keep the trigger disabled and
      // preserve diagnostics if exact shutdown cannot be proved.
      try {
        if (registered) await checked(plan.disable, cleanup)
      } catch (error) { failures.push(error) }
      try {
        if (guestStaged && taskStarted) {
          const stopped = await stopSupervisor(cleanup)
          await proveStopped(stopped, cleanup)
          taskStarted = false
        }
      } catch (error) { failures.push(error) }
      try {
        if (registered && !taskStarted) await removeWindowsTask(plan.removal, effects, cleanup)
      } catch (error) { failures.push(error) }
      try {
        if (bystanderRegistered) await removeWindowsTask(bystander.removal, effects, cleanup)
      } catch (error) { failures.push(error) }
      try {
        if (guestStaged) {
          companion = await processIdentity(cleanup, "/companion.json") ?? companion
          await guest("require('node:fs').writeFileSync(process.argv[1] + '/companion.stop', '')", [home], cleanup)
          if (companion) {
            const stopped = companion
            await observe(async () => !(await alive(stopped, cleanup)) ? true : undefined, cleanup)
          }
        }
      } catch (error) { failures.push(error) }
      try {
        // Never delete the stop input while an owned guest could still need it.
        if (guestStaged && failures.length === 0) await guest(
          "require('node:fs').rmSync(process.argv[1], { recursive: true })", [home], cleanup)
      } catch (error) { failures.push(error) }
      finally { cleanup.clear() }
      if (failures.length) {
        failure = new AggregateError(failure === undefined ? failures : [failure, ...failures],
          "WSL service proof or fixture cleanup failed", { cause: failure ?? failures[0] })
      }
    }
    if (failure !== undefined) throw failure
  },
  budget.test,
)
