import { createHash } from "node:crypto"

import { localOwnerRecordPath, readLocalOwnerRecord, readLocalProfileFile, type LocalOwnerRecord } from "../local-owner-record.js"
import type { LocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"

export type ServiceRemovalSnapshot = {
  owner: LocalOwnerRecord | undefined
  configurationDigest: string | null
  registrationId?: string
  // A record or configuration that exists but cannot be read is not proof of
  // anything. Removal still proceeds; no receipt can be derived from it.
  unreadable?: string
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function readServiceRemovalSnapshot(homeDirectory: string, platform: string): ServiceRemovalSnapshot {
  let owner: LocalOwnerRecord | undefined
  let unreadable: string | undefined
  try {
    owner = readLocalOwnerRecord(homeDirectory)
  } catch (error) {
    unreadable = `The profile owner record could not be read at ${localOwnerRecordPath(homeDirectory)}: ${failureDetail(error)}`
  }
  const configurationPath = serviceConfigurationPath(homeDirectory, platform)
  let text: string
  try {
    text = readLocalProfileFile(configurationPath, 64 * 1_024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      unreadable ??= `The saved service configuration at ${configurationPath} could not be read: ${failureDetail(error)}`
    }
    return { owner, configurationDigest: null, ...(unreadable === undefined ? {} : { unreadable }) }
  }
  const configurationDigest = createHash("sha256").update(text).digest("hex")
  if (unreadable !== undefined) return { owner, configurationDigest, unreadable }
  // A malformed or legacy config can still be removed, but cannot assert a
  // registration binding. Only the explicit operator path can recover it.
  try {
    const { registrationId } = parseServiceConfiguration(text)
    return { owner, configurationDigest, ...(registrationId ? { registrationId } : {}) }
  } catch {
    return { owner, configurationDigest }
  }
}

export type ServiceRemovalRecovery =
  | { kind: "not-needed" }
  | { kind: "proof-unavailable"; reason: string }
  | { kind: "operator-confirmation-required"; instanceId: string }
  | { kind: "receipt"; instanceId: string; machineId: string; registrationId: string }

// Called only after the manager's stop/removal proof and after taking the free
// profile lease. Compare both sides of the external wait before deleting any
// saved launch input. Neither a missing job nor a vanished config is proof.
export function serviceRemovalRecovery(
  before: ServiceRemovalSnapshot, after: ServiceRemovalSnapshot, managerStopped: boolean,
): ServiceRemovalRecovery {
  if (before.configurationDigest !== after.configurationDigest) throw new Error("Service configuration changed during removal. No recovery receipt was written; inspect the supervisor before retrying.")
  const unreadable = before.unreadable ?? after.unreadable
  if (unreadable !== undefined) return { kind: "proof-unavailable", reason: unreadable }
  const current = after.owner
  if (!current || current.state === "none") return { kind: "not-needed" }
  const previous = before.owner
  if (!previous || previous.state === "none" || current.instanceId !== previous.instanceId
    || current.machineId !== previous.machineId || current.serviceRegistrationId !== previous.serviceRegistrationId) {
    throw new Error("Profile owner changed during service removal. No recovery receipt was written; inspect the supervisor before retrying.")
  }
  const registrationId = before.registrationId
  if (!managerStopped || !registrationId || current.owner !== "daemon" || current.serviceRegistrationId !== registrationId
    || registrationId !== after.registrationId) return { kind: "operator-confirmation-required", instanceId: current.instanceId }
  return { kind: "receipt", instanceId: current.instanceId, machineId: current.machineId, registrationId }
}

export function serviceRemovalReceipt(
  recovery: Extract<ServiceRemovalRecovery, { kind: "receipt" }>, platform: string,
): LocalOwnerRemovalReceipt {
  const manager = platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : platform === "win32" ? "task-scheduler" : undefined
  if (!manager) throw new Error("Unknown service manager cannot authorize profile recovery")
  return {
    version: 1, instanceId: recovery.instanceId, machineId: recovery.machineId, completedAt: new Date().toISOString(),
    authorization: { kind: "service-removal", manager, registrationId: recovery.registrationId },
  }
}
