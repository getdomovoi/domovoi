import { createHash } from "node:crypto"
import { lstatSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { claimExclusiveFileLease } from "../file-lease.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { OperationDeadline } from "../operation-deadline.js"
import { parseServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { superviseGuest } from "./guest-supervisor.js"
import type { ServiceStatus } from "./install.js"
import { guestProcessAlive, guestProcessIdentity, launchGuestChild } from "./supervisor-process.js"
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

function assertObservableLaunches(record: SupervisorRecord): void {
  // A spawn may have completed before its birth identity was published. An
  // empty slot is not evidence that no unrecorded child survived the loop.
  if (record.attempts.some((attempt) => attempt.child === null && attempt.exit === null)) {
    throw new Error("Supervisor launch has no recorded child outcome; removal or another loop refused")
  }
}

function boundRecord(path: string): SupervisorRecord | undefined {
  const configuration = configurationAt(path)
  const record = readSupervisorRecord(configuration.homeDirectory)
  if (record && (record.registrationId !== configuration.registrationId
    || record.configurationDigest !== supervisorConfigurationDigest(configuration))) {
    throw new Error("Supervisor record does not match the installed service configuration")
  }
  return record
}

function lastExit(record: SupervisorRecord): string {
  const exit = record.attempts.at(-1)?.exit
  if (!exit) return "no completed child exit recorded"
  const value = exit.errorCode !== null ? `launch failure ${exit.errorCode}`
    : exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`
  return `last exit ${value} at ${exit.at}`
}

export function readGuestSupervisorStatus(home: string, alive = guestProcessAlive): ServiceStatus | undefined {
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
  const record = boundRecord(join(home, ".domovoi/service.json"))
  if (!record) throw new Error("Supervisor record disappeared during status")
  const loopAlive = alive(record.loop)
  if (!loopAlive) assertObservableLaunches(record)
  const activeChild = record.attempts.at(-1)
  const running = record.state === "running" && loopAlive && activeChild?.child !== null
    && activeChild?.child !== undefined && activeChild.exit === null && alive(activeChild.child)
  const detail = record.state === "exhausted" ? `stopped; supervision exhausted after ${record.crashes} crashes; ${lastExit(record)}`
    : record.state === "failed" ? `stopped; supervision refused after an observation failure; ${lastExit(record)}`
      : record.state === "stopped" ? `stopped (${record.reason?.kind}); ${lastExit(record)}`
        : !loopAlive ? `stopped; supervisor is not alive; ${lastExit(record)}`
          : record.state === "backoff" ? `child stopped; supervisor backing off ${activeChild?.backoffMs} ms; ${lastExit(record)}`
            : running ? `guest daemon running; attempt ${record.attemptCount}; ${record.crashes} crashes`
              : `child stopped; supervisor ${record.state}; ${lastExit(record)}`
  // A guest record cannot establish whether the Windows registration exists.
  return { installed: null, running, detail }
}

export async function stopGuestSupervisor(path: string, deadline: OperationDeadline, effects: {
  alive(identity: GuestProcessIdentity): boolean
  wait(): Promise<void>
} = { alive: guestProcessAlive, wait: async () => { await delay(100, undefined, { signal: deadline.signal }) } }): Promise<SupervisorRecord> {
  deadline.throwIfExpired()
  const configuration = configurationAt(path)
  const initial = boundRecord(path)
  if (!initial) throw new Error("Supervisor shutdown requires its recorded identity")
  writeSupervisorStopRequest(configuration.homeDirectory, initial)
  for (;;) {
    deadline.throwIfExpired()
    const current = boundRecord(path)
    if (!current || current.supervisorId !== initial.supervisorId || !sameProcess(current.loop, initial.loop)) {
      throw new Error("Supervisor identity changed during shutdown")
    }
    const loopAlive = effects.alive(current.loop)
    const childrenAlive = current.attempts.some((attempt) => attempt.child !== null && effects.alive(attempt.child))
    if (!loopAlive && !childrenAlive) { assertObservableLaunches(current); return current }
    if (!loopAlive) throw new Error("Supervisor stopped but its guest child is still alive; removal refused")
    await withinServiceDeadline(deadline, effects.wait)
  }
}

export async function runGuestSupervisor(path: string, entry: { executable: string; args: string[] }): Promise<SupervisorRecord> {
  if (process.platform !== "linux") throw new Error("The guest supervisor requires Linux process birth identities")
  const configuration = configurationAt(path)
  const home = configuration.homeDirectory
  prepareSupervisorDirectory(home)
  const leasePath = join(home, ".domovoi/supervisor-lease.sqlite")
  try {
    const info = lstatSync(leasePath)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("Supervisor lease must be an owned private regular file")
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const lease = claimExclusiveFileLease(leasePath, () => new Error("This guest supervisor is already running"))
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
  const [released] = await Promise.allSettled([Promise.resolve().then(() => lease.release())])
  if (outcome.status === "rejected") {
    if (released.status === "rejected") throw new AggregateError([outcome.reason, released.reason],
      "Supervisor failure and lease release failure", { cause: outcome.reason })
    throw outcome.reason
  }
  if (released.status === "rejected") throw released.reason
  return outcome.value
}
