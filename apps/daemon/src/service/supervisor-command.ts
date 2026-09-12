import { createHash } from "node:crypto"
import { lstatSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { claimExclusiveFileLease, type FileLease } from "../file-lease.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { OperationDeadline } from "../operation-deadline.js"
import { parseServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { superviseGuest } from "./guest-supervisor.js"
import type { ServiceStatus } from "./install.js"
import { guestBootId, guestProcessAlive, guestProcessIdentity, launchGuestChild } from "./supervisor-process.js"
import { prepareSupervisorDirectory, readSupervisorRecord, readSupervisorStopRequest, supervisorRecordPath, writeSupervisorRecord,
  writeSupervisorStopRequest, type GuestProcessIdentity, type SupervisorRecord } from "./supervisor-record.js"

export const supervisorConfigurationDigest = (configuration: ServiceConfiguration): string =>
  createHash("sha256").update(serializeServiceConfiguration(
    parseServiceConfiguration(serializeServiceConfiguration(configuration)),
  )).digest("hex")

function configurationAt(path: string): ServiceConfiguration & { registrationId: string } {
  const config = parseServiceConfiguration(readLocalProfileFile(path, 64 * 1024))
  if (!config.registrationId || resolve(path) !== resolve(join(config.homeDirectory, ".domovoi/service.json"))) {
    throw new Error("Guest supervisor requires the profile's installed service configuration and registration")
  }
  return { ...config, registrationId: config.registrationId }
}

const sameProcess = (left: GuestProcessIdentity, right: GuestProcessIdentity): boolean =>
  left.pid === right.pid && left.start === right.start && left.bootId === right.bootId

function assertObservableLaunches(record: SupervisorRecord, bootId = guestBootId): void {
  // A spawn may have completed before its birth identity was published. An
  // empty slot is not evidence that no unrecorded child survived the loop.
  // A different kernel boot is such evidence. Never infer it from a failed
  // boot probe or just from a changed PID, task result or distro start.
  if (record.attempts.some((attempt) => attempt.child === null && attempt.exit === null)) {
    if (record.loop.bootId !== bootId()) return
    throw new Error("Supervisor launch has no recorded child outcome; removal or another loop refused")
  }
}

function assertRecordConfiguration(record: SupervisorRecord, configuration: ServiceConfiguration): void {
  if (record.registrationId !== configuration.registrationId
    || record.configurationDigest !== supervisorConfigurationDigest(configuration)) {
    throw new Error("Supervisor record does not match the installed service configuration")
  }
}

function boundRecord(path: string): SupervisorRecord | undefined {
  const configuration = configurationAt(path)
  const record = readSupervisorRecord(configuration.homeDirectory)
  if (record) assertRecordConfiguration(record, configuration)
  return record
}

function lastExit(record: SupervisorRecord): string {
  const exit = record.attempts.at(-1)?.exit
  if (!exit) return "no completed child exit recorded"
  const value = exit.errorCode !== null ? `launch failure ${exit.errorCode}`
    : exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`
  return `last exit ${value} at ${exit.at}`
}

class GuestSupervisorBusyError extends Error {}

function claimGuestSupervisorLease(home: string): FileLease {
  prepareSupervisorDirectory(home)
  const path = join(home, ".domovoi/supervisor-lease.sqlite")
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32"
      && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new Error("Supervisor lease must be an owned private regular file")
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return claimExclusiveFileLease(path, () => new GuestSupervisorBusyError("This guest supervisor is already running"))
}

async function releaseGuestSupervisorLease<T>(lease: FileLease, outcome: PromiseSettledResult<T>): Promise<T> {
  const [released] = await Promise.allSettled([Promise.resolve().then(() => lease.release())])
  if (outcome.status === "rejected") {
    if (released.status === "rejected") throw new AggregateError([outcome.reason, released.reason],
      "Supervisor failure and lease release failure", { cause: outcome.reason })
    throw outcome.reason
  }
  if (released.status === "rejected") throw released.reason
  return outcome.value
}

export function readGuestSupervisorStatus(home: string, alive = guestProcessAlive, bootId = guestBootId): ServiceStatus | undefined {
  let present = true
  try { lstatSync(supervisorRecordPath(home)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    present = false
  }
  if (!present) {
    try { lstatSync(join(home, ".domovoi/supervisor-lease.sqlite")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    throw new Error("Supervisor record is missing; supervision cannot be verified")
  }
  // Removal can leave private history after service.json is gone. Preserve
  // that evidence without declaring supervision absent or querying systemd.
  // Only a missing configuration is tolerated; malformed or mismatched data
  // still refuses. Startup and shutdown continue to require the binding.
  let configuration: ServiceConfiguration | undefined
  try { configuration = configurationAt(join(home, ".domovoi/service.json")) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const record = readSupervisorRecord(home)
  if (!record) throw new Error("Supervisor record disappeared during status")
  if (configuration) assertRecordConfiguration(record, configuration)
  const loopAlive = alive(record.loop)
  if (!loopAlive) assertObservableLaunches(record, bootId)
  const activeChild = record.attempts.at(-1)
  const running = record.state === "running" && loopAlive && activeChild?.child !== null
    && activeChild?.child !== undefined && activeChild.exit === null && alive(activeChild.child)
  const observed = record.state === "exhausted" ? `stopped; supervision exhausted after ${record.crashes} crashes; ${lastExit(record)}`
    : record.state === "failed" ? `stopped; supervision refused after an observation failure; ${lastExit(record)}`
      : record.state === "stopped" ? `stopped (${record.reason?.kind}); ${lastExit(record)}`
        : !loopAlive ? `stopped; supervisor is not alive; ${lastExit(record)}`
          : record.state === "backoff" ? `child stopped; supervisor backing off ${activeChild?.backoffMs} ms; ${lastExit(record)}`
            : running ? `guest daemon running; attempt ${record.attemptCount}; ${record.crashes} crashes`
              : `child stopped; supervisor ${record.state}; ${lastExit(record)}`
  const supervisionFailure = configuration === undefined ? "configuration-missing"
    : record.state === "exhausted" ? "exhausted" : record.state === "failed" ? "observation-failure" : undefined
  const detail = configuration ? observed : `service configuration missing; guest evidence is not bound to an installed service; ${observed}`
  // A guest record cannot establish whether the Windows registration exists.
  return { installed: null, running, detail, ...(supervisionFailure === undefined ? {} : { supervisionFailure }) }
}

export async function stopGuestSupervisor(path: string, deadline: OperationDeadline, effects: {
  alive(identity: GuestProcessIdentity): boolean
  bootId?: () => string
  wait(): Promise<void>
} = { alive: guestProcessAlive, wait: async () => { await delay(100, undefined, { signal: deadline.signal }) } }): Promise<SupervisorRecord> {
  deadline.throwIfExpired()
  const configuration = configurationAt(path)
  const initial = boundRecord(path)
  if (!initial) throw new Error("Supervisor shutdown requires its recorded identity")
  writeSupervisorStopRequest(configuration.homeDirectory, initial)
  const proof = (): SupervisorRecord | undefined => {
    const current = boundRecord(path)
    if (!current || current.supervisorId !== initial.supervisorId || !sameProcess(current.loop, initial.loop)) {
      throw new Error("Supervisor identity changed during shutdown")
    }
    const loopAlive = effects.alive(current.loop)
    const childrenAlive = current.attempts.some((attempt) => attempt.child !== null && effects.alive(attempt.child))
    if (!loopAlive && !childrenAlive) { assertObservableLaunches(current, effects.bootId ?? guestBootId); return current }
    if (!loopAlive) throw new Error("Supervisor stopped but its guest child is still alive; removal refused")
    return undefined
  }
  for (;;) {
    deadline.throwIfExpired()
    if (proof() !== undefined) {
      let lease: FileLease | undefined
      try { lease = claimGuestSupervisorLease(configuration.homeDirectory) } catch (error) {
        if (!(error instanceof GuestSupervisorBusyError)) throw error
      }
      if (lease) {
        // A successor may hold the startup lease before publishing its record.
        // Re-read and prove death under that same lease; the retirement marker
        // then prevents another start after the proof releases it.
        const [outcome] = await Promise.allSettled([Promise.resolve().then(() => { deadline.throwIfExpired(); return proof() })])
        const stopped = await releaseGuestSupervisorLease(lease, outcome)
        if (stopped !== undefined) return stopped
      }
    }
    await withinServiceDeadline(deadline, effects.wait)
  }
}

export async function runGuestSupervisor(path: string, entry: { executable: string; args: string[] }): Promise<SupervisorRecord> {
  if (process.platform !== "linux") throw new Error("The guest supervisor requires Linux process birth identities")
  const configuration = configurationAt(path)
  const home = configuration.homeDirectory
  const lease = claimGuestSupervisorLease(home)
  const controller = new AbortController()
  const stop = () => controller.abort()
  let latest: SupervisorRecord | undefined
  let observationFailure: unknown
  let monitor: ReturnType<typeof setInterval> | undefined
  const execute = async (): Promise<SupervisorRecord> => {
    const retirement = readSupervisorStopRequest(home)
    if (retirement?.registrationId === configuration.registrationId) {
      throw new Error("This supervisor registration was stopped for removal; reinstall before starting another loop")
    }
    const previous = readSupervisorRecord(home)
    if (previous && (guestProcessAlive(previous.loop)
      || previous.attempts.some((attempt) => attempt.child !== null && guestProcessAlive(attempt.child)))) {
      throw new Error("A recorded supervisor or guest child is still alive; another loop is refused")
    }
    if (previous) assertObservableLaunches(previous)
    const loop = guestProcessIdentity(process.pid)
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)
    monitor = setInterval(() => {
      try {
        const request = readSupervisorStopRequest(home)
        if (request && latest && request.supervisorId === latest.supervisorId
          && request.registrationId === latest.registrationId && sameProcess(request.loop, loop)) stop()
      } catch (error) { observationFailure = error; stop() }
    }, 100)
    const final = await superviseGuest({ loop, registrationId: configuration.registrationId,
      configurationDigest: supervisorConfigurationDigest(configuration), signal: controller.signal }, {
      now: () => new Date(),
      write: (record) => { writeSupervisorRecord(home, record); latest = record },
      launch: () => launchGuestChild(entry.executable, entry.args, { environment: { ...process.env, HOME: home } }),
      wait: async (ms, signal) => { await delay(ms, undefined, { signal }) },
    })
    if (observationFailure !== undefined) {
      const [publication] = await Promise.allSettled([Promise.resolve().then(() => {
        writeSupervisorRecord(home, { ...final, state: "failed", updatedAt: new Date().toISOString(),
          reason: { kind: "observation-failure", at: new Date().toISOString() } })
      })])
      if (publication.status === "rejected") throw new AggregateError([observationFailure, publication.reason],
        "Supervisor observation failed and its refusal could not be recorded", { cause: observationFailure })
      throw observationFailure
    }
    return final
  }
  const [outcome] = await Promise.allSettled([execute()])
  if (monitor) clearInterval(monitor)
  process.removeListener("SIGTERM", stop)
  process.removeListener("SIGINT", stop)
  return releaseGuestSupervisorLease(lease, outcome)
}
