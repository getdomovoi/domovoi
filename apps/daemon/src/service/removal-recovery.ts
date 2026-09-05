import { createHash } from "node:crypto"

import { readLocalOwnerRecord, readLocalProfileFile, type LocalOwnerRecord } from "../local-owner-record.js"
import type { LocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"

export type ServiceRemovalSnapshot = {
  owner: LocalOwnerRecord | undefined
  configurationDigest: string | null
  registrationId?: string
}

export function readServiceRemovalSnapshot(homeDirectory: string, platform: string): ServiceRemovalSnapshot {
  const owner = readLocalOwnerRecord(homeDirectory)
  let text: string
  try {
    text = readLocalProfileFile(serviceConfigurationPath(homeDirectory, platform), 64 * 1_024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { owner, configurationDigest: null }
    throw error
  }
  const configurationDigest = createHash("sha256").update(text).digest("hex")
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
  | { kind: "operator-confirmation-required"; instanceId: string }
  | { kind: "receipt"; instanceId: string; machineId: string; registrationId: string }

// Called only after the manager's stop/removal proof and after taking the free
// profile lease. Compare both sides of the external wait before deleting any
// saved launch input. Neither a missing job nor a vanished config is proof.
export function serviceRemovalRecovery(
  before: ServiceRemovalSnapshot, after: ServiceRemovalSnapshot, managerStopped: boolean,
): ServiceRemovalRecovery {
  if (before.configurationDigest !== after.configurationDigest) throw new Error("Service configuration changed during removal. No recovery receipt was written; inspect the supervisor before retrying.")
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
