import { createHash, randomUUID } from "node:crypto"
import { lstatSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { claimExclusiveFileLease, type FileLease } from "../file-lease.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { profileDirectory, profileLocation, type ProfileLocation } from "../profile-directory.js"
import type { OperationDeadline } from "../operation-deadline.js"
import { parseServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import type { ServiceStatus } from "./install.js"
import { launchWindowsJob, queryWindowsProcess, windowsProcessAlive, type WindowsJob, type WindowsJobEmpty } from "./windows-job.js"
import { windowsProcessIdentitySchema, prepareSupervisorDirectory, readSupervisorStopRequest, readWindowsSupervisorRecord,
  supervisorBackoffs, supervisorStopPath, writeSupervisorStopRequest, writeWindowsSupervisorRecord, windowsSupervisorRecordSchema,
  type WindowsProcessIdentity, type WindowsSupervisorRecord } from "./supervisor-record.js"

export const windowsTreeUnknown = "The Windows daemon tree is unconfirmed. Its job-empty evidence is missing, so another start, stop confirmation, and removal are refused. The task and service configuration are retained. Restart Windows to settle the tree from this recorded boot, then retry."
const digest = (configuration: ServiceConfiguration) => createHash("sha256").update(serializeServiceConfiguration(configuration)).digest("hex")

export function assertWindowsTreeProof(record: WindowsSupervisorRecord, bootId: string): void {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  windowsSupervisorRecordSchema.parse(record)
  if (record.loop.bootId !== bootId) return
  if (record.attempts.some((a) => !a.empty)) throw new Error(windowsTreeUnknown)
}

export function assertWindowsStartup(previous: WindowsSupervisorRecord | undefined, bootId: string,
  alive: (identity: WindowsProcessIdentity) => boolean): void {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  // Called under the exclusive startup lease. Intent is published before any
  // launch, so absence means no launch, even if an earlier boot query failed.
  // This relies on the same user not deleting the profile's evidence files.
  if (!previous) return
  assertWindowsTreeProof(previous, bootId)
  if (previous.loop.bootId === bootId && alive(previous.loop)) throw new Error("A recorded Windows supervisor is still alive")
}

export function windowsSupervisorStatus(record: WindowsSupervisorRecord, bootId: string, loopAlive: boolean, childAlive = loopAlive): ServiceStatus {
  windowsProcessIdentitySchema.shape.bootId.parse(bootId)
  windowsSupervisorRecordSchema.parse(record)
  if ((!loopAlive || record.state === "failed") && record.loop.bootId === bootId && record.attempts.some((a) => !a.empty)) {
    return { installed: null, running: false, treeUnconfirmed: true, supervisionFailure: "observation-failure", detail: windowsTreeUnknown }
  }
  const last = record.attempts.at(-1)
  const running = record.loop.bootId === bootId && loopAlive && childAlive && record.state === "running"
  const unexpectedLoopExit = !loopAlive && !["stopped", "failed", "exhausted"].includes(record.state)
  const failure = record.state === "exhausted" ? "exhausted" : record.state === "failed" || unexpectedLoopExit ? "observation-failure" : undefined
  const observed = record.loop.bootId !== bootId ? "recorded daemon tree ended with an earlier Windows boot"
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

type Attempt = WindowsSupervisorRecord["attempts"][number]
export type WindowsSupervisorEffects = {
  now(): Date
  write(record: WindowsSupervisorRecord): void
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
  const save = () => { record.updatedAt = time(); effects.write(structuredClone(record)) }
  const finish = (state: "stopped" | "failed" | "exhausted", reason: WindowsSupervisorRecord["reason"]) => {
    record.state = state; record.reason = reason; save(); return record
  }
  let job: WindowsJob | undefined
  const acceptEmpty = (attempt: Attempt, empty: WindowsJobEmpty) => {
    if (empty.job !== attempt.job || empty.bootId !== attempt.bootId || empty.activeProcesses !== 0 || empty.terminated !== true) throw new Error(windowsTreeUnknown)
    attempt.empty = { at: time(), activeProcesses: 0, terminated: true }; attempt.exitCode = empty.code; attempt.stage = "empty"
  }
  try {
    save()
    for (;;) {
      if (input.signal.aborted) return finish("stopped", "deliberate-stop")
      const attempt: Attempt = { number: record.attempts.length + 1, job: `Local\\Domovoi-${randomUUID()}`, bootId: input.loop.bootId,
        startedAt: time(), stage: "intent", child: null, helper: null, empty: null, exitCode: null, backoffMs: 0 }
      record.attempts.push(attempt); record.state = "starting"; save()
      job = await effects.launch(attempt)
      if (job.prepared.job !== attempt.job || job.prepared.bootId !== attempt.bootId || job.prepared.killOnClose !== true) throw new Error("Windows job preparation disagrees with its attempt")
      attempt.child = job.prepared.child; attempt.helper = job.prepared.helper; attempt.stage = "prepared"; save()
      if (!input.signal.aborted) {
        await job.resume()
        attempt.stage = "running"; record.state = "running"; save()
      }
      let detach = () => {}
      const interrupted = new Promise<undefined>((yes) => {
        const stop = () => yes(undefined)
        input.signal.addEventListener("abort", stop, { once: true }); detach = () => input.signal.removeEventListener("abort", stop)
        if (input.signal.aborted) stop()
      })
      let empty: WindowsJobEmpty | undefined
      try { empty = await Promise.race([interrupted, job.exited]) } finally { detach() }
      if (!empty) { record.state = "stopping"; save(); empty = await job.stop() }
      acceptEmpty(attempt, empty); job = undefined
      if (input.signal.aborted || empty.stopped) return finish("stopped", "deliberate-stop")
      if (empty.code === 0) return finish("stopped", "clean-exit")
      ++record.crashes
      const backoff = supervisorBackoffs[record.crashes - 1]
      if (backoff === undefined) return finish("exhausted", "restart-limit")
      attempt.backoffMs = backoff; record.state = "backoff"; save()
      try { await effects.wait(backoff, input.signal) } catch (error) { if (!input.signal.aborted) throw error }
    }
  } catch (error) {
    // Cleanup can supply an empty receipt, never a guessed successful exit.
    // Even successful cleanup does not turn an observation failure into retry.
    const attempt = record.attempts.at(-1)
    if (job && attempt) {
      try { acceptEmpty(attempt, await job.stop()) } catch { /* Preserve the incomplete evidence. */ }
    }
    try { return finish("failed", "observation-failure") } catch (publication) {
      throw new AggregateError([error, publication], "Windows supervision failed and its refusal could not be recorded", { cause: error })
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
  if (record && (record.registrationId !== config.registrationId
    || (record.configurationDigest !== digest(config) && record.configurationDigest !== previousConfigurationDigest))) {
    throw new Error("Windows supervisor evidence does not match the installed service configuration")
  }
  return record
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
    assertWindowsStartup(previous, observed.bootId, windowsProcessAlive)
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
    })
    if (monitorError !== undefined) {
      record.state = "failed"; record.reason = "observation-failure"; record.updatedAt = new Date().toISOString(); writeWindowsSupervisorRecord(home, record)
    }
    return record
  } finally {
    if (monitor) clearInterval(monitor)
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
    lease.release()
  }
}

export function readWindowsSupervisorStatus(home: string): ServiceStatus | undefined {
  let config: ServiceConfiguration | undefined
  try { config = configurationAt(join(home, ".domovoi", "service.json")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const record = config ? boundRecord(config) : readWindowsSupervisorRecord(home)
  if (!record) return undefined
  const bootId = queryWindowsProcess(process.pid).bootId
  const loopAlive = record.loop.bootId === bootId && windowsProcessAlive(record.loop)
  const child = record.attempts.at(-1)?.child
  const status = windowsSupervisorStatus(record, bootId, loopAlive, !!child && loopAlive && windowsProcessAlive(child))
  return config ? status : { ...status, supervisionFailure: "configuration-missing", detail: `service configuration missing; ${status.detail}` }
}

export async function stopWindowsSupervisor(path: string, deadline: OperationDeadline,
  options: { retire?: boolean; previousConfigurationDigest?: string } = {}): Promise<WindowsSupervisorRecord> {
  deadline.throwIfExpired()
  const config = configurationAt(path), home = profileLocation(config.homeDirectory, config.profileDirectory)
  // A rollback may have written the new service.json before a new loop ever
  // started. Its caller supplies the exact old configuration digest it read
  // under the service-operation lease, never an arbitrary-record fallback.
  const initial = boundRecord(config, options.previousConfigurationDigest)
  let requester = initial?.loop
  if (!requester) {
    requester = queryWindowsProcess(process.pid).identity ?? undefined
    if (!requester) throw new Error("Windows retirement requester identity is unavailable")
  }
  writeSupervisorStopRequest(home, { registrationId: config.registrationId!, supervisorId: initial?.supervisorId ?? randomUUID(), loop: requester })
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
          writeWindowsSupervisorRecord(home, current)
        }
        assertWindowsTreeProof(current, queryWindowsProcess(process.pid).bootId)
        deadline.throwIfExpired()
        // Update holds the service-operation lease and disabled the task. Only
        // that caller may permit this registration to start again after proof.
        if (options.retire === false) rmSync(supervisorStopPath(home))
        return current
      } finally { lease.release() }
    }
    await withinServiceDeadline(deadline, () => delay(100, undefined, { signal: deadline.signal }))
  }
}
