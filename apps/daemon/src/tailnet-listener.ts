import { X509Certificate } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"

import type { TailnetListenerStatus } from "@getdomovoi/protocol"

import type { TlsMaterial, TlsMaterialPaths } from "./tls-material.js"

// TailnetReach (Q404 A): the second listener, TLS only, on this machine's
// Tailscale address beside the loopback one. The production factory loads its
// certificate and key; when that fails it passes the reason instead, and the
// daemon starts on loopback alone and reports the listener as refused.
export type DaemonTailnetListenerOptions = {
  address: string
  tls: TlsMaterial | { refused: string }
  // How long the daemon waits before binding an address that was not on this
  // machine yet (Tailscale not up at login). Tests shorten it.
  retryMs?: number
  // The longest the timer armed for the certificate's notAfter waits before
  // it checks the clock again. Tests shorten it.
  expiryRecheckMs?: number
}

// Review of 049b1383 (P2-1): the tailnet certificate and key are loaded only
// when both are regular files, and within their own short bound, so a FIFO, a
// directory or a stalled read refuses the tailnet listener alone instead of
// holding the daemon's startup deadline.
export const defaultTailnetTlsTimeoutMs = 5_000
// A certificate chain or a key is a few kilobytes; a larger file is not read.
const maximumTailnetTlsBytes = 64 * 1_024

// Codex review round 1 (P2-2): the file at path itself, never what a link
// there names. It is opened without following a link (O_NOFOLLOW; an lstat
// first says so where that flag does not exist), and without waiting on a
// FIFO (O_NONBLOCK), and every check runs on the opened file, so a file
// swapped in after a check is never the one read. The read stops past 64 KiB.
async function readTailnetFile(path: string, what: "certificate" | "key"): Promise<Buffer> {
  const refused = (why: string) => new Error(`The tailnet ${what} at ${path} ${why}, so the daemon answers on this computer only.`)
  const unreadable = (error: unknown) => new Error(`Domovoi could not read the tailnet ${what} at ${path} (${(error as NodeJS.ErrnoException).code ?? "unreadable"}), so the daemon answers on this computer only.`)
  let handle: FileHandle
  try {
    if ((await lstat(path)).isSymbolicLink()) throw refused("is a link")
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ELOOP" || code === "EMLINK") throw refused("is a link")
    throw code === undefined && error instanceof Error ? error : unreadable(error)
  }
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) throw refused("is not a regular file")
    if (entry.size > maximumTailnetTlsBytes) throw refused("is larger than 64 KiB")
    // A key any other account can read is already disclosed (tls-material.ts).
    if (what === "key" && process.platform !== "win32" && (entry.mode & 0o077) !== 0) throw new Error(`TLS private key must not be readable by other users: ${path}`)
    const buffer = Buffer.alloc(maximumTailnetTlsBytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > maximumTailnetTlsBytes) throw refused("is larger than 64 KiB")
    }
    return Buffer.from(buffer.subarray(0, length))
  } finally {
    await handle.close()
  }
}

// The tailnet certificate and key, read as readTailnetFile reads, with the
// PEM checks the main listener's loader makes (tls-material.ts).
export async function readTailnetTlsMaterial(paths: TlsMaterialPaths): Promise<TlsMaterial> {
  const cert = await readTailnetFile(paths.certPath, "certificate")
  const key = await readTailnetFile(paths.keyPath, "key")
  if (!cert.toString("utf8").includes("BEGIN CERTIFICATE")) throw new Error(`TLS certificate is not PEM encoded: ${paths.certPath}`)
  if (!key.toString("utf8").includes("PRIVATE KEY")) throw new Error(`TLS private key is not PEM encoded: ${paths.keyPath}`)
  return { cert, key }
}

export async function loadTailnetTls(
  load: (paths: TlsMaterialPaths) => Promise<TlsMaterial>,
  paths: TlsMaterialPaths,
  timeoutMs = defaultTailnetTlsTimeoutMs,
): Promise<TlsMaterial | { refused: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ refused: string }>((settle) => {
    timer = setTimeout(() => settle({ refused: `The tailnet certificate and key at ${paths.certPath} were not read within ${timeoutMs / 1_000} seconds, so the daemon answers on this computer only.` }), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([load(paths).catch((error: unknown) => ({ refused: error instanceof Error ? error.message : "The tailnet certificate and key could not be read." })), late])
  } finally {
    clearTimeout(timer)
  }
}

export const defaultTailnetRetryMs = 30_000
// Codex review round 1 (P3-7): a listening daemon closes the tailnet listener
// at the certificate's notAfter, from a timer armed for that moment, not from
// a poll. A timer waits at most 2^31 - 1 ms (about 24.8 days), and a
// certificate lasts 90, so a longer wait is re-armed when it fires.
const maximumTimerMs = 2_147_483_647
export function tailnetExpiryDelay(notAfter: number, now: number, recheckMs = maximumTimerMs): number {
  return Math.max(0, Math.min(notAfter - now, recheckMs, maximumTimerMs))
}

// A reason travels in tailnet.status, bounded at 512 characters there.
const maximumReasonLength = 512
export function boundedTailnetReason(reason: string): string {
  const trimmed = reason.trim() || "The tailnet listener was refused."
  return trimmed.length <= maximumReasonLength ? trimmed : `${trimmed.slice(0, maximumReasonLength - 1)}…`
}

// The certificate's notAfter, and whether the daemon serves it at all. An
// expired certificate is never served: every device would refuse it, and the
// design says the daemon answers on this computer only until a renewal.
export function tailnetCertificateCheck(certificate: Buffer, now: number): { notAfter: Date; refused?: string } | { refused: string } {
  let notAfter: Date
  try {
    notAfter = new Date(new X509Certificate(certificate).validTo)
  } catch {
    return { refused: "The tailnet certificate could not be read as an X.509 certificate, so the daemon answers on this computer only." }
  }
  if (Number.isNaN(notAfter.getTime())) {
    return { refused: "The tailnet certificate could not be read as an X.509 certificate, so the daemon answers on this computer only." }
  }
  if (notAfter.getTime() <= now) {
    return { notAfter, refused: `The tailnet certificate expired on ${notAfter.toISOString().slice(0, 10)}, so the daemon answers on this computer only.` }
  }
  return { notAfter }
}

export type TailnetListenerState =
  | { state: "off" }
  | { state: "listening"; address: string; port: number; notAfter: Date }
  | { state: "refused"; address: string; reason: string; retrying: boolean; notAfter?: Date }

export function tailnetStatusOf(state: TailnetListenerState): TailnetListenerStatus {
  if (state.state === "off") return { state: "off" }
  if (state.state === "listening") {
    return { state: "listening", address: state.address, port: state.port, certificateExpiresAt: state.notAfter.toISOString() }
  }
  return {
    state: "refused", address: state.address, reason: boundedTailnetReason(state.reason), retrying: state.retrying,
    ...(state.notAfter ? { certificateExpiresAt: state.notAfter.toISOString() } : {}),
  }
}
