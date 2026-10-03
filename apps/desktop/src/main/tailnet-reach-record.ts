// TailnetReach (Q404 A): what the switch saved when it was turned on, in the
// app's data directory. It names the only files the switch wrote, so turning
// it off deletes those and nothing else, and it gives the in-app daemon its
// tailnet settings at each start. index.ts loads this module only when such a
// record exists or the switch is used, so it is not part of startup otherwise.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { isIPv4, isIPv6 } from "node:net"
import { homedir } from "node:os"
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

// A DNS name of lower-case labels whose last label holds a letter, so it is
// never an IP literal: the daemon refuses a loopback or wildcard address as
// DOMOVOI_TAILNET_HOST (transport-config.ts tailnetHostSchema).
const hostLabels = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

// Re-review of 10dba4a2 (P2): and one the URL parser keeps as it is. It reads
// 1.0x0 as 1.0.0.0 and 127.0x1 as 127.0.0.1; the daemon refuses any name it
// rewrites, and so does this. The switch takes Tailscale's name by this rule
// too, so it never writes a record the parser would refuse.
export function tailnetName(name: string): boolean {
  if (!hostLabels.test(name)) return false
  try {
    return new URL(`wss://${name}:1/`).hostname === name
  } catch {
    return false
  }
}

// The ranges the daemon accepts, checked as it checks them (config.ts
// isTailscaleAddress): 100.64.0.0/10, or fd7a:115c:a1e0::/48 written without
// an IPv4 tail or a zone.
function tailscaleAddress(value: string): boolean {
  if (isIPv4(value)) return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(value)
  if (!isIPv6(value) || value.includes(".") || value.includes("%")) return false
  const [head = "", tail] = value.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return false
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right].map((group) => Number.parseInt(group, 16))
  return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0
}

// <profile>/tls, the only directory the switch writes, with the profile named
// as the daemon names it (profile-directory.ts): DOMOVOI_PROFILE_DIR when it is
// absolute, otherwise <home>/.domovoi. None for a profile the daemon refuses.
export function tailnetTlsDirectory(environment: Readonly<Record<string, string | undefined>>, home: string): string | undefined {
  const paths = win32.isAbsolute(home) && !posix.isAbsolute(home) ? win32 : posix
  const configured = environment.DOMOVOI_PROFILE_DIR
  if (configured === undefined) return paths.join(home, ".domovoi", "tls")
  return paths.isAbsolute(configured) && !/[\0\r\n]/u.test(configured) ? paths.join(configured, "tls") : undefined
}

// The certificate and key the switch writes for name, and nothing else.
export function tailnetFiles(tlsDirectory: string, name: string): { certPath: string; keyPath: string } {
  const separator = tlsDirectory.includes("\\") && !tlsDirectory.includes("/") ? "\\" : "/"
  return { certPath: `${tlsDirectory}${separator}${name}.crt`, keyPath: `${tlsDirectory}${separator}${name}.key` }
}

// Undefined for anything that is not exactly a record this app writes: a name
// and address the daemon accepts, so a saved record never stops it starting,
// and the certificate and key at <tlsDirectory>/<name>.crt and .key, so turning
// the switch off or renewing touches only those two files.
export function parseTailnetReachRecord(text: string, tlsDirectory: string): TailnetReachRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null) return undefined
    const { version, name, address: bound, certPath, keyPath, ...rest } = value as Record<string, unknown>
    if (version !== 1 || Object.keys(rest).length > 0) return undefined
    if (typeof name !== "string" || !tailnetName(name) || typeof bound !== "string" || !tailscaleAddress(bound)) return undefined
    const files = tailnetFiles(tlsDirectory, name)
    if (certPath !== files.certPath || keyPath !== files.keyPath) return undefined
    return { version, name, address: bound, ...files }
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

// The record saved in dataDirectory for the profile environment names, or none.
// Read synchronously because the acquisition options are built so.
export function savedTailnetReachRecord(dataDirectory: string, environment: Readonly<Record<string, string | undefined>>, home = homedir()): TailnetReachRecord | undefined {
  const tls = tailnetTlsDirectory(environment, home)
  if (tls === undefined) return undefined
  const text = readTailnetReachRecordText(join(dataDirectory, tailnetReachRecordFile))
  return text === undefined ? undefined : parseTailnetReachRecord(text, tls)
}

// A record is under 300 bytes.
const recordLimit = 4 * 1_024

// Codex review round 1 (P2-3): the record's text, read only when the file at
// path is a regular file of at most 4 KiB and not a link. It is opened without
// following a link (O_NOFOLLOW, with an lstat first where that flag does not
// exist) and without waiting on a FIFO (O_NONBLOCK), and checked on the opened
// file, so nothing placed at the path can hold the main process before the
// daemon starts. Anything else, or any error, is no record: the daemon starts
// on loopback. Synchronous, because startup builds the acquisition options so.
export function readTailnetReachRecordText(path: string): string | undefined {
  let descriptor: number
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return undefined
  }
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile() || entry.size > recordLimit) return undefined
    const buffer = Buffer.alloc(recordLimit + 1)
    let length = 0
    for (let read = -1; read !== 0 && length <= recordLimit;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null)
      length += read
    }
    return length > recordLimit ? undefined : buffer.toString("utf8", 0, length)
  } catch {
    return undefined
  } finally {
    closeSync(descriptor)
  }
}

// The settings for a daemon started with environment, or none.
export function savedTailnetReachEnvironment(dataDirectory: string, environment: Readonly<Record<string, string | undefined>>, home = homedir()): Record<string, string> {
  return tailnetHostConflict(environment) === undefined ? tailnetReachEnvironment(savedTailnetReachRecord(dataDirectory, environment, home)) : {}
}
