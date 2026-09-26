import { daemonAuthenticationErrorCode, devicePairingLimitErrorCode, pairingCodeSchema, protocolVersion, protocolVersionMismatchErrorCode, type ClientKind } from "@getdomovoi/protocol"
import type { PairingOutcome } from "@getdomovoi/ui"

import { DaemonRpcError } from "@/client"

import { daemonSessionFrom, isDaemonCredential, type DaemonSession } from "./credential"

export type PairingClient = {
  connect(): Promise<unknown>
  request(method: "device.pair", params: { label: string; client: ClientKind }): Promise<unknown>
  request(method: "device.redeemCode", params: { code: string; label: string; protocolVersion: string }): Promise<unknown>
  disconnect(): void
}

// A bearer only for the credential path; a code is redeemed with nothing.
export type PairingClientFactory = (input: {
  url: string
  client: ClientKind
  bearer?: string
}) => PairingClient

export const webCodeShapeMessage = "A web code is the daemon's word code, like hearth-quiet-ember-42, shown on the machine in Settings under Phone and tablet."

// The code the machine shows is spent once, here, to enrol this browser as
// its own paired device. The daemon decides the kind from the code, so a code
// shown for a phone cannot mint a browser credential.
export async function redeemBrowserCode(input: {
  url: string
  client: ClientKind
  code: string
  label: string
  createClient: PairingClientFactory
  // Called once the socket opened, so the page may speak of the connection.
  onConnected?: (() => void) | undefined
}): Promise<DaemonSession> {
  const code = pairingCodeSchema.safeParse(input.code.trim())
  if (!code.success) throw new Error(webCodeShapeMessage)
  const client = input.createClient({ url: input.url, client: input.client })
  try {
    await client.connect()
    input.onConnected?.()
    return daemonSessionFrom(
      await client.request("device.redeemCode", { code: code.data, label: input.label, protocolVersion }),
    )
  } finally {
    client.disconnect()
  }
}

// What the daemon said, as the page draws it. Every bad code gets one uniform
// refusal from the daemon on purpose, so the page cannot say whether a code
// expired, was spent, or came from another machine, and does not guess.
export function pairingOutcomeFor(cause: unknown, host: string): Omit<PairingOutcome, "action"> {
  if (cause instanceof DaemonRpcError) {
    if (cause.code === protocolVersionMismatchErrorCode) {
      const data = (typeof cause.data === "object" && cause.data !== null ? cause.data : {}) as { daemonProtocolVersion?: unknown; clientProtocolVersion?: unknown }
      const page = typeof data.clientProtocolVersion === "string" ? data.clientProtocolVersion : protocolVersion
      const daemon = typeof data.daemonProtocolVersion === "string" ? data.daemonProtocolVersion : "unknown"
      return { tone: "danger", pill: "refused", title: `This page is older than the daemon on ${host}`, mono: `pair.refused · protocol_mismatch · page ${page}, daemon ${daemon}`, body: "The daemon was updated while this tab was open. Reload the page to update it. The daemon needs nothing. The code was not used." }
    }
    if (cause.code === devicePairingLimitErrorCode) {
      return { tone: "danger", pill: "refused", title: `${host} has no room for another device`, mono: "pair.refused · device_limit", body: "Unpair a device on the machine, under Machines, then show another code." }
    }
    if (cause.code === daemonAuthenticationErrorCode) {
      return { tone: "plain", pill: "refused", title: "That code was refused", mono: "pair.refused · works once · 180s", body: `It may have expired or been used already. Show another on ${host}, under Settings, Phone and tablet.` }
    }
    return { tone: "danger", pill: "refused", title: "The daemon refused pairing", mono: `pair.refused · ${cause.code}`, body: cause.message }
  }
  if (cause instanceof Error && cause.message === webCodeShapeMessage) {
    return { tone: "plain", pill: "not sent", title: "That is not a web code", mono: "word-word-word-00", body: cause.message }
  }
  return { tone: "plain", pill: "unconfirmed", title: `${host} did not answer, so pairing is unconfirmed`, mono: `pair · no reply · ${host}`, body: "The daemon may have stopped or left the tailnet. If the machine lists this browser under Phone and tablet, it paired." }
}

export const daemonCredentialShapeMessage =
  "A daemon credential is one 43 character line. Copy the whole line from ~/.domovoi/daemon.token on the execution machine."

// The pasted credential is the daemon's root bearer: it authenticates every
// client and cannot be withdrawn on its own. It is spent once, here, to enrol
// this browser as its own paired device, and only that device credential is
// handed back for the tab to keep.
export async function pairBrowserDevice(input: {
  url: string
  client: ClientKind
  bearer: string
  label: string
  createClient: PairingClientFactory
}): Promise<DaemonSession> {
  if (!isDaemonCredential(input.bearer)) throw new Error(daemonCredentialShapeMessage)
  const client = input.createClient({ url: input.url, client: input.client, bearer: input.bearer })
  try {
    await client.connect()
    return daemonSessionFrom(
      await client.request("device.pair", { label: input.label, client: input.client }),
    )
  } finally {
    client.disconnect()
  }
}
