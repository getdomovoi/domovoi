import { X509Certificate } from "node:crypto"

import type { TailnetListenerStatus } from "@getdomovoi/protocol"

import type { TlsMaterial } from "./tls-material.js"

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
}

export const defaultTailnetRetryMs = 30_000

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
