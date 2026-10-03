// TailnetReach (Q404 A): what the switch saved when it was turned on, in the
// app's data directory. It names the only files the switch wrote, so turning
// it off deletes those and nothing else, and it gives the in-app daemon its
// tailnet settings at each start. index.ts reads it at every acquisition, so
// this module stays small: it is part of the main process's startup bundle.

import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"

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

// Undefined for anything that is not exactly a record this app wrote. The
// daemon checks the settings again (config.ts) before it listens anywhere.
export function parseTailnetReachRecord(text: string): TailnetReachRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null) return undefined
    const { version, name, address: bound, certPath, keyPath, ...rest } = value as Record<string, unknown>
    if (version !== 1 || Object.keys(rest).length > 0) return undefined
    if (typeof name !== "string" || !hostName.test(name) || typeof bound !== "string" || isIP(bound) === 0) return undefined
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

// The settings saved in dataDirectory, or none. Read synchronously because the
// daemon's acquisition options are built synchronously.
export function savedTailnetReachEnvironment(dataDirectory: string): Record<string, string> {
  try {
    return tailnetReachEnvironment(parseTailnetReachRecord(readFileSync(join(dataDirectory, tailnetReachRecordFile), "utf8")))
  } catch {
    return {}
  }
}
