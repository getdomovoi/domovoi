import { credentialSchema, deviceIdSchema, devicePairResultSchema, type ClientKind } from "@getdomovoi/protocol"

import { BrowserCapabilityError } from "./platform-refusals"

const daemonSessionKey = "domovoi.daemon-session"
const supersededCredentialKey = "domovoi.daemon-credential"

export type DaemonSession = {
  deviceId: string
  token: string
}

type CredentialStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">

const clientLabels: Record<ClientKind, string> = {
  desktop: "Desktop",
  web: "Web",
  tablet: "Tablet",
  phone: "Phone",
  cli: "Command line",
}

export function browserDeviceLabel(client: ClientKind, suffix: string): string {
  return `${clientLabels[client]} browser ${suffix}`
}

export function isDaemonCredential(value: string): boolean {
  return credentialSchema.safeParse(value).success
}

export function daemonSessionFrom(result: unknown): DaemonSession {
  const parsed = devicePairResultSchema.safeParse(result)
  if (!parsed.success) throw new Error("The daemon did not return a device credential for this browser")
  return { deviceId: parsed.data.device.id, token: parsed.data.token }
}

export function loadDaemonSession(storage: CredentialStorage): DaemonSession | undefined {
  let raw: string | null
  try {
    raw = storage.getItem(daemonSessionKey)
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const deviceId = deviceIdSchema.safeParse(record.deviceId)
  const token = credentialSchema.safeParse(record.token)
  if (!deviceId.success || !token.success) return undefined
  return { deviceId: deviceId.data, token: token.data }
}

export function saveDaemonSession(storage: CredentialStorage, session: DaemonSession): void {
  try {
    storage.setItem(daemonSessionKey, JSON.stringify(session))
  } catch {
    throw new BrowserCapabilityError("credentials-unavailable")
  }
}

// Earlier builds parked the daemon's root bearer under its own key. A tab
// restored from one of those sessions still holds a credential that speaks for
// the whole machine, so every entry point drops it before anything else runs.
export function forgetSupersededCredential(storage: CredentialStorage): void {
  try {
    storage.removeItem(supersededCredentialKey)
  } catch {
    return
  }
}

export function clearDaemonSession(storage: CredentialStorage): void {
  forgetSupersededCredential(storage)
  try {
    storage.removeItem(daemonSessionKey)
  } catch {
    throw new BrowserCapabilityError("credentials-unavailable")
  }
}
