import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { claimExclusiveFileLease, type FileLease } from "../file-lease.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { profileDirectory, profileLocation, type ProfileLocation } from "../profile-directory.js"
import type { OperationDeadline } from "../operation-deadline.js"
import { parseServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceStatus } from "./install.js"
import { launchWindowsJob, queryWindowsJob, queryWindowsProcess, queryWindowsProcesses, windowsProcessAlive, WindowsJobStartupError, type WindowsJob, type WindowsJobEmpty } from "./windows-job.js"
import { windowsProcessIdentitySchema, prepareSupervisorDirectory, readSupervisorStopRequest, readWindowsSupervisorRecord,
  supervisorBackoffs, supervisorStopPath, writeSupervisorStopRequest, writeWindowsSupervisorRecord, windowsSupervisorRecordSchema,
  type WindowsProcessIdentity, type WindowsSupervisorRecord } from "./supervisor-record.js"

export const windowsTreeUnknown = "The Windows daemon tree is unconfirmed. Neither empty-job nor confirmed kill-on-close closure evidence is available, so another start, stop confirmation, and removal are refused. The task and service configuration are retained. Restart Windows to settle the tree from this recorded boot, then retry."
const digest = (configuration: ServiceConfiguration) => createHash("sha256").update(serializeServiceConfiguration(configuration)).digest("hex")

export function assertWindowsTreeProof(record: WindowsSupervisorRecord, bootId: string): void {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  windowsSupervisorRecordSchema.parse(record)
  if (record.loop.bootId !== bootId) return
  if (record.attempts.some((a) => !a.empty && !a.closure)) throw new Error(windowsTreeUnknown)
}

// Q9 A, 2026-10-06: this proof establishes that kill-on-close started, not
// that all descendants have completed termination. The daemon's profile lease
// still excludes another owner. Global names remain observable across logons.
function recoverWindowsJobClosure(record: WindowsSupervisorRecord, bootId: string, deadline?: OperationDeadline): WindowsSupervisorRecord {
  if (record.loop.bootId !== bootId) return record
  const recovered = structuredClone(record)
  for (const attempt of recovered.attempts) {
    if (attempt.empty || attempt.closure || !attempt.killOnClose || !attempt.child) continue
    const observed = queryWindowsJob(attempt.job, attempt.child.pid, deadline)
    if (observed.bootId !== bootId) throw new Error("Windows boot changed during job observation; retry")
    const daemonAlive = observed.identity?.start === attempt.child.start
    if (observed.jobExists || daemonAlive) continue
    attempt.closure = { at: new Date().toISOString(), jobAbsent: true, daemonDead: true }
    attempt.stage = "closed"
    recovered.state = "stopped"; recovered.reason = "job-closed"
  }
  return windowsSupervisorRecordSchema.parse(recovered)
}

export function assertWindowsStartup(previous: WindowsSupervisorRecord | undefined, bootId: string,
  alive: (identity: WindowsProcessIdentity) => boolean): void {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  // Called under the exclusive startup lease. Intent is published before any
  // launch, so absence means no launch, even if an earlier boot query failed.
  // This relies on the same user not deleting the profile's evidence files.
  if (!previous) return
  assertWindowsTreeProof(previous, bootId)
  // The exclusive lease excludes the settled loop; its PID may now name a
  // protected process unrelated to this registration.
  if (terminalWindowsTreeProof(previous)) return
  if (previous.loop.bootId === bootId && alive(previous.loop)) throw new Error("A recorded Windows supervisor is still alive")
}

export function windowsSupervisorStatus(record: WindowsSupervisorRecord, bootId: string, loopAlive: boolean, childAlive = loopAlive): ServiceStatus {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  windowsSupervisorRecordSchema.parse(record)
  if ((!loopAlive || record.state === "failed") && record.loop.bootId === bootId && record.attempts.some((a) => !a.empty && !a.closure)) {
    return { installed: null, running: false, treeUnconfirmed: true, supervisionFailure: "observation-failure", detail: windowsTreeUnknown }
  }
  const last = record.attempts.at(-1)
  const running = record.loop.bootId === bootId && loopAlive && childAlive && record.state === "running"
  const unexpectedLoopExit = !loopAlive && !["stopped", "failed", "exhausted"].includes(record.state)
  const failure = record.state === "exhausted" ? "exhausted" : record.state === "failed" || unexpectedLoopExit ? "observation-failure" : undefined
  const observed = record.loop.bootId !== bootId ? "recorded daemon tree ended with an earlier Windows boot"
    : last?.closure ? "daemon identity dead and Global job name absent; kill-on-close termination started, completion not observed; profile lease guards a second owner"
    : record.state === "exhausted" ? `supervision exhausted after ${record.crashes} crashes and ${record.attempts.length} attempts; last exit ${last?.exitCode}`
      : record.state === "failed" ? "supervision refused after an observation failure"
        : record.state === "stopped" ? `stopped (${record.reason}); daemon jobs confirmed empty`
          : !loopAlive ? "supervisor is not alive; recorded daemon jobs confirmed empty"
            : record.state === "backoff" ? `daemon stopped; supervisor backing off ${last?.backoffMs} ms`
              : running ? `daemon running; attempt ${record.attempts.length}; ${record.crashes} crashes`
                : `supervisor ${record.state}; daemon readiness unconfirmed`
  const supervising = record.loop.bootId === bootId && loopAlive && !["stopped", "failed", "exhausted"].includes(record.state)
  return { installed: null, running, supervising, detail: observed, ...(failure ? { supervisionFailure: failure } : {}) }
}

// Windows MoveFileEx can refuse replacement while status or stop readers, or
// antivirus scans, hold the target open. Bound sharing retries to five seconds,
// well below the helper's 15 second startup acknowledgement for prepared jobs.
async function publishWindowsRecord(publish: () => void, pause: (ms: number) => Promise<void> = delay,
  deadline?: OperationDeadline): Promise<void> {
  const expiresAt = performance.now() + 5_000
  let backoffMs = 25
  for (;;) {
    deadline?.throwIfExpired()
    try { publish(); return } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException | null)?.code ?? "")) throw error
      const remaining = expiresAt - performance.now()
      if (remaining <= 0) throw error
      deadline?.throwIfExpired()
      await pause(Math.min(backoffMs, remaining, deadline?.remainingMs() ?? Infinity))
      deadline?.throwIfExpired()
      if (performance.now() >= expiresAt) throw error
      backoffMs = Math.min(backoffMs * 2, 500)
    }
  }
}

type Attempt = WindowsSupervisorRecord["attempts"][number]
export type WindowsSupervisorEffects = {
  now(): Date
  write(record: WindowsSupervisorRecord): void
  // Publication must finish even when a deliberate stop has been requested.
  pause?(ms: number): Promise<void>
  launch(attempt: Attempt): Promise<WindowsJob>
  wait(ms: number, signal: AbortSignal): Promise<void>
}
export async function superviseWindows(input: {
  loop: WindowsProcessIdentity; registrationId: string; configurationDigest: string; signal: AbortSignal
}, effects: WindowsSupervisorEffects): Promise<WindowsSupervisorRecord> {
  const time = () => effects.now().toISOString()
  const began = time()
  const record: WindowsSupervisorRecord = { version: 1, platform: "win32", supervisorId: randomUUID(),
    registrationId: input.registrationId, configurationDigest: input.configurationDigest, loop: input.loop,
    startedAt: began, updatedAt: began, state: "starting", attempts: [], crashes: 0, reason: null }
  const save = async () => {
    record.updatedAt = time()
    const snapshot = structuredClone(record)
    await publishWindowsRecord(() => effects.write(snapshot), effects.pause)
  }
  const finish = async (state: "stopped" | "failed" | "exhausted", reason: WindowsSupervisorRecord["reason"]) => {
    record.state = state; record.reason = reason; await save(); return record
  }
  let job: WindowsJob | undefined
  const acceptPrepared = (attempt: Attempt, prepared: WindowsJob["prepared"]) => {
    if (prepared.job !== attempt.job || prepared.bootId !== attempt.bootId || prepared.killOnClose !== true || prepared.stdioOnly !== true) throw new Error("Windows job preparation disagrees with its attempt")
    attempt.killOnClose = true; attempt.child = prepared.child; attempt.helper = prepared.helper; attempt.stage = "prepared"
  }
  const acceptEmpty = (attempt: Attempt, empty: WindowsJobEmpty) => {
    if (empty.job !== attempt.job || empty.bootId !== attempt.bootId || empty.activeProcesses !== 0 || empty.terminated !== true) throw new Error(windowsTreeUnknown)
    attempt.empty = { at: time(), activeProcesses: 0, terminated: true }; attempt.exitCode = empty.code; attempt.stage = "empty"
  }
  try {
    await save()
    for (;;) {
      if (input.signal.aborted) return await finish("stopped", "deliberate-stop")
      const attempt: Attempt = { number: record.attempts.length + 1, job: `Global\\Domovoi-${randomUUID()}`, bootId: input.loop.bootId,
        startedAt: time(), stage: "intent", child: null, helper: null, empty: null, exitCode: null, backoffMs: 0 }
      record.attempts.push(attempt); record.state = "starting"; await save()
      job = await effects.launch(attempt)
      acceptPrepared(attempt, job.prepared); await save()
      if (!input.signal.aborted) {
        await job.resume()
        attempt.stage = "running"; record.state = "running"; await save()
      }
      let detach = () => {}
      const interrupted = new Promise<undefined>((yes) => {
        const stop = () => yes(undefined)
        input.signal.addEventListener("abort", stop, { once: true }); detach = () => input.signal.removeEventListener("abort", stop)
        if (input.signal.aborted) stop()
      })
      let empty: WindowsJobEmpty | undefined
      try { empty = await Promise.race([interrupted, job.exited]) } finally { detach() }
      if (!empty) { record.state = "stopping"; await save(); empty = await job.stop() }
      acceptEmpty(attempt, empty); job = undefined
      if (input.signal.aborted || empty.stopped) return await finish("stopped", "deliberate-stop")
      if (empty.code === 0) return await finish("stopped", "clean-exit")
      ++record.crashes
      const backoff = supervisorBackoffs[record.crashes - 1]
      if (backoff === undefined) return await finish("exhausted", "restart-limit")
      attempt.backoffMs = backoff; record.state = "backoff"; await save()
      try { await effects.wait(backoff, input.signal) } catch (error) { if (!input.signal.aborted) throw error }
    }
  } catch (error) {
    // Cleanup can supply an empty receipt, never a guessed successful exit.
    // Even successful cleanup does not turn an observation failure into retry.
    const attempt = record.attempts.at(-1)
    if (error instanceof WindowsJobStartupError && error.prepared && attempt) {
      try {
        acceptPrepared(attempt, error.prepared)
        if (error.receipt) acceptEmpty(attempt, error.receipt)
      } catch { /* Preserve incomplete evidence when cleanup does not match this attempt. */ }
    }
    if (job && attempt) {
      try { acceptEmpty(attempt, await job.stop()) } catch { /* Preserve the incomplete evidence. */ }
    }
    try { return await finish("failed", "observation-failure") } catch (publication) {
      throw new AggregateError([error, publication], "Windows supervision failed and its refusal could not be recorded", { cause: publication })
    }
  }
}

class WindowsSupervisorBusyError extends Error {}
function claim(home: ProfileLocation): FileLease {
  prepareSupervisorDirectory(home)
  const path = join(profileDirectory(home), "windows-supervisor-lease.sqlite")
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new Error("Windows supervisor lease must be a private regular file")
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return claimExclusiveFileLease(path, () => new WindowsSupervisorBusyError("Windows supervisor still owns its startup lease"))
}
function configurationAt(path: string) {
  const config = parseServiceConfiguration(readLocalProfileFile(path, 64 * 1024))
  if (!config.registrationId || resolve(path) !== resolve(join(config.homeDirectory, ".domovoi", "service.json"))) {
    throw new Error("Windows supervision requires the installed service configuration and registration")
  }
  return { ...config, registrationId: config.registrationId }
}
function boundRecord(config: ServiceConfiguration, previousConfigurationDigest?: string): WindowsSupervisorRecord | undefined {
  const record = readWindowsSupervisorRecord(profileLocation(config.homeDirectory, config.profileDirectory))
  // A settled predecessor is not launch history for a replacement registration.
  // Stop still claims the startup lease and re-reads history before proving no launch.
  if (record && record.registrationId !== config.registrationId && terminalWindowsTreeProof(record)) return undefined
  if (record && (record.registrationId !== config.registrationId
    || (record.configurationDigest !== digest(config) && record.configurationDigest !== previousConfigurationDigest))) {
    throw new Error("Windows supervisor evidence does not match the installed service configuration")
  }
  return record
}

function terminalWindowsTreeProof(record: WindowsSupervisorRecord): boolean {
  return ["stopped", "failed", "exhausted"].includes(record.state)
    && record.attempts.every((attempt) => attempt.empty || attempt.closure)
}

export async function runWindowsSupervisor(path: string, entry: { executable: string; args: string[] }): Promise<WindowsSupervisorRecord> {
  if (process.platform !== "win32") throw new Error("Windows job supervision requires Windows")
  const config = configurationAt(path), home = profileLocation(config.homeDirectory, config.profileDirectory)
  const lease = claim(home)
  const controller = new AbortController()
  const stop = () => controller.abort()
  let monitor: ReturnType<typeof setInterval> | undefined
  let monitorError: unknown
  try {
    const observed = queryWindowsProcess(process.pid)
    if (!observed.identity) throw new Error("Windows supervisor birth identity is unavailable")
    const previous = readWindowsSupervisorRecord(home)
    assertWindowsStartup(previous ? recoverWindowsJobClosure(previous, observed.bootId) : undefined, observed.bootId, windowsProcessAlive)
    if (readSupervisorStopRequest(home)?.registrationId === config.registrationId) throw new Error("This Windows supervisor registration was stopped; reinstall before starting it")
    process.on("SIGINT", stop); process.on("SIGTERM", stop)
    monitor = setInterval(() => {
      try {
        const request = readSupervisorStopRequest(home)
        // Retirement is sticky for this registration, including when stop
        // read the predecessor just before this loop published its identity.
        if (request?.registrationId === config.registrationId) stop()
      } catch (error) { monitorError = error; stop() }
    }, 100)
    const record = await superviseWindows({ loop: observed.identity, registrationId: config.registrationId, configurationDigest: digest(config), signal: controller.signal }, {
      now: () => new Date(), write: (record) => { writeWindowsSupervisorRecord(home, record) },
      launch: (attempt) => launchWindowsJob({ job: attempt.job, ...entry, log: join(profileDirectory(home), "windows-daemon.log") }),
      wait: async (ms, signal) => { await delay(ms, undefined, { signal }) },
      pause: delay,
    })
    if (monitorError !== undefined) {
      record.state = "failed"; record.reason = "observation-failure"; record.updatedAt = new Date().toISOString()
      await publishWindowsRecord(() => { writeWindowsSupervisorRecord(home, record) })
    }
    return record
  } finally {
    if (monitor) clearInterval(monitor)
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
    lease.release()
  }
}

export function readWindowsSupervisorStatus(home: string, deadline?: OperationDeadline): ServiceStatus | undefined {
  deadline?.throwIfExpired()
  let config: ServiceConfiguration | undefined
  try { config = configurationAt(join(home, ".domovoi", "service.json")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const record = config ? boundRecord(config) : readWindowsSupervisorRecord(home)
  if (!record) return undefined
  // Recorded PIDs may now belong to protected processes. Query our own boot
  // first, then inspect only identities whose liveness can still affect status.
  const bootId = queryWindowsProcess(process.pid, deadline).bootId
  const terminalProof = terminalWindowsTreeProof(record)
  let observedRecord = record, loopAlive = false, childAlive = false
  if (record.loop.bootId === bootId && !terminalProof) {
    const last = record.attempts.at(-1)
    const child = last?.empty || last?.closure ? undefined : last?.child
    const observed = queryWindowsProcesses([record.loop.pid, ...(child ? [child.pid] : [])], deadline)
    if (observed.bootId !== bootId) throw new Error("Windows boot changed during status observation; retry")
    loopAlive = observed.identities[0]?.start === record.loop.start
    childAlive = !!child && observed.identities[1]?.start === child.start
    if (!loopAlive || record.state === "failed") observedRecord = recoverWindowsJobClosure(record, bootId, deadline)
  }
  const status = windowsSupervisorStatus(observedRecord, bootId, loopAlive, childAlive)
  return config ? status : { ...status, supervisionFailure: "configuration-missing", detail: `service configuration missing; ${status.detail}` }
}

export async function stopWindowsSupervisor(path: string, deadline: OperationDeadline,
  options: { retire?: boolean; previousConfigurationDigest?: string; confirmNoLaunch?: () => Promise<boolean>; stopTask?: () => Promise<boolean> } = {}): Promise<WindowsSupervisorRecord> {
  deadline.throwIfExpired()
  const config = configurationAt(path), home = profileLocation(config.homeDirectory, config.profileDirectory)
  // A rollback may have written the new service.json before a new loop ever
  // started. Its caller supplies the exact old configuration digest it read
  // under the service-operation lease, never an arbitrary-record fallback.
  const initial = boundRecord(config, options.previousConfigurationDigest)
  if (!initial && !existsSync(join(profileDirectory(home), "windows-supervisor-lease.sqlite"))) {
    // Only a verified supervised registration can establish this alternative
    // to a prior lease: disabled, with no queued or running scheduler instance.
    // Re-read history under our exclusive lease below before recording no launch.
    if (!await withinServiceDeadline(deadline, async () => options.confirmNoLaunch?.() ?? false)) {
      throw new Error("Windows supervisor evidence is missing and no startup lease exists; legacy tree shutdown cannot be proved. Configuration retained.")
    }
  }
  let requester = initial?.loop
  if (!requester) {
    requester = queryWindowsProcess(process.pid, deadline).identity ?? undefined
    if (!requester) throw new Error("Windows retirement requester identity is unavailable")
  }
  const pause = (ms: number) => withinServiceDeadline(deadline, () => delay(ms))
  const request = { registrationId: config.registrationId!, supervisorId: initial?.supervisorId ?? randomUUID(), loop: requester }
  await publishWindowsRecord(() => { writeSupervisorStopRequest(home, request) }, pause, deadline)
  for (;;) {
    deadline.throwIfExpired()
    let lease: FileLease | undefined
    try { lease = claim(home) } catch (error) { if (!(error instanceof WindowsSupervisorBusyError)) throw error }
    if (lease) {
      try {
        let current = boundRecord(config, options.previousConfigurationDigest)
        if (!current) {
          if (initial) throw new Error("Windows supervisor evidence disappeared during shutdown")
          // No active loop and no published intent means no launch. Publish
          // a terminal record, retaining the registration's retirement marker.
          const now = new Date().toISOString()
          current = { version: 1, platform: "win32", supervisorId: randomUUID(), registrationId: config.registrationId!,
            configurationDigest: digest(config), loop: requester, startedAt: now, updatedAt: now,
            state: "stopped", attempts: [], crashes: 0, reason: "deliberate-stop" }
        }
        const bootId = queryWindowsProcess(process.pid, deadline).bootId
        current = recoverWindowsJobClosure(current, bootId, deadline)
        assertWindowsTreeProof(current, bootId)
        const settled = current
        await publishWindowsRecord(() => { writeWindowsSupervisorRecord(home, settled) }, pause, deadline)
        deadline.throwIfExpired()
        if (options.retire === false) {
          // Hold both the startup lease and retirement marker through scheduler
          // stop. Queued old instances must not claim and launch at this seam.
          // Only a disabled task with zero instances permits clearing retirement.
          if (!await withinServiceDeadline(deadline, async () => options.stopTask?.() ?? false)) {
            throw new Error("Windows task was not confirmed stopped with no instances; retirement retained")
          }
          deadline.throwIfExpired()
          rmSync(supervisorStopPath(home))
        }
        return current
      } finally { lease.release() }
    }
    await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal }))
  }
}
