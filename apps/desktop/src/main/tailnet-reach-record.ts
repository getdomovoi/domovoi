// TailnetReach (Q404 A): what the switch saved when it was turned on, in the
// app's data directory. It names the only files the switch wrote, so turning
// it off deletes those and nothing else, and it gives the in-app daemon its
// tailnet settings at each start. index.ts loads this module only when such a
// record exists or the switch is used, so it is not part of startup otherwise.

import { readFileSync } from "node:fs"
import { isIPv4, isIPv6 } from "node:net"
import { join, posix, win32 } from "node:path"

// index.ts names the file too, to check for it without loading this module.
export const tailnetReachRecordFile = "tailnet-reach.json"

export type TailnetReachRecord = {
  version: 1
  name: string
  address: string
  certPath: string
  keyPath: string
}

const hostName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const path = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/u.test(value)
  && value.trim() === value && (posix.isAbsolute(value) || win32.isAbsolute(value))

// The ranges the daemon accepts (config.ts): 100.64.0.0/10 and fd7a:115c:a1e0::/48.
function tailscaleAddress(value: string): boolean {
  if (isIPv4(value)) return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(value)
  if (!isIPv6(value)) return false
  try {
    // The URL form is lower case and compressed, never across the first three groups here.
    return new URL(`http://[${value}]/`).hostname.startsWith("[fd7a:115c:a1e0:")
  } catch {
    return false
  }
}

// Undefined for anything that is not exactly a record this app wrote, with
// settings the daemon accepts: a record it refused would stop it starting.
export function parseTailnetReachRecord(text: string): TailnetReachRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null) return undefined
    const { version, name, address: bound, certPath, keyPath, ...rest } = value as Record<string, unknown>
    if (version !== 1 || Object.keys(rest).length > 0) return undefined
    if (typeof name !== "string" || !hostName.test(name) || typeof bound !== "string" || !tailscaleAddress(bound)) return undefined
    if (!path(certPath) || !path(keyPath)) return undefined
    return { version, name, address: bound, certPath, keyPath }
  } catch {
    return undefined
  }
}

// The daemon settings the record stands for: a TLS listener on the tailnet
// address beside loopback, advertised under the tailnet name.
export function tailnetReachEnvironment(record: TailnetReachRecord | undefined): Record<string, string> {
  return record ? {
    DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
    DOMOVOI_TAILNET_ADDRESS: record.address,
    DOMOVOI_TAILNET_TLS_CERT_PATH: record.certPath,
    DOMOVOI_TAILNET_TLS_KEY_PATH: record.keyPath,
    DOMOVOI_TAILNET_HOST: record.name,
  } : {}
}

// The daemon refuses a tailnet listener beside a listener that is not
// loopback (config.ts), and a refused setting stops it starting. A hand-set
// DOMOVOI_HOST like that already reaches off this machine, so the saved
// settings are left out and the switch says why.
export function tailnetHostConflict(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const host = environment.DOMOVOI_HOST
  if (host === undefined || host === "127.0.0.1" || host === "::1" || host === "localhost") return undefined
  return `DOMOVOI_HOST is set to ${host} in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener.`
}

// The settings saved in dataDirectory for a daemon started with environment,
// or none. Read synchronously because the acquisition options are built so.
export function savedTailnetReachEnvironment(dataDirectory: string, environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (tailnetHostConflict(environment) !== undefined) return {}
  try {
    return tailnetReachEnvironment(parseTailnetReachRecord(readFileSync(join(dataDirectory, tailnetReachRecordFile), "utf8")))
  } catch {
    return {}
  }
}
