import { daemonAuthenticationErrorCode, devicePairingLimitErrorCode, devicePairResultSchema, pairingCodeSchema, protocolVersion, protocolVersionMismatchErrorCode, type ClientKind } from "@getdomovoi/protocol"
import type { PairingOutcome } from "@getdomovoi/ui"

import { DaemonRpcError } from "@/client"

import { daemonSessionFrom, isDaemonCredential, type DaemonSession } from "./credential"

type PairingConnection = {
  connect(): Promise<unknown>
  disconnect(): void
}

export type BearerPairingClient = PairingConnection & {
  request(method: "device.pair", params: { label: string; client: ClientKind }): Promise<unknown>
}

export type CodePairingClient = PairingConnection & {
  request(method: "device.redeemCode", params: { code: string; label: string; protocolVersion: string }): Promise<unknown>
}

// A bearer only for the credential path. A code is redeemed with nothing, and
// its client sends the code before any greeting: the daemon refuses a
// greeting from a tab that holds no credential, so a code sent after one is
// never spent.
export type PairingClientFactory = {
  (input: { url: string; client: ClientKind; bearer: string }): BearerPairingClient
  (input: { url: string; client: ClientKind }): CodePairingClient
}

// The daemon's words for a refused code. It answers a refused greeting with
// the same error code and other words, and that is not the code's fault.
const codeRefusalMessage = "Pairing was refused"

// How the page names a kind: what the device is, and the code the machine
// shows for it. The connect prompt, the field and the refusal cards read the
// same row, so a browser is asked for the code it will keep.
const kindNames: Record<ClientKind, { device: string; code: string }> = {
  web: { device: "a web browser", code: "web code" },
  phone: { device: "a phone", code: "phone code" },
  tablet: { device: "a tablet", code: "tablet code" },
  desktop: { device: "the desktop app", code: "desktop code" },
  cli: { device: "the command line", code: "command line code" },
}

export function codeNameFor(client: ClientKind): string {
  return kindNames[client].code
}

export function codeShapeMessage(client: ClientKind): string {
  const code = codeNameFor(client)
  return `A ${code} is the daemon's word code, like hearth-quiet-ember-42, shown on the machine in Settings under Phone and tablet.`
}

export class CodeShapeError extends Error {
  readonly expected: ClientKind

  constructor(expected: ClientKind) {
    super(codeShapeMessage(expected))
    this.name = "CodeShapeError"
    this.expected = expected
  }
}

// The code the machine shows is spent once, here, to enrol this browser as
// its own paired device. The daemon decides the kind from the code, and a
// credential for a kind this tab does not greet as is not kept.
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
  if (!code.success) throw new CodeShapeError(input.client)
  const client = input.createClient({ url: input.url, client: input.client })
  try {
    await client.connect()
    input.onConnected?.()
    const redeemed = await client.request("device.redeemCode", { code: code.data, label: input.label, protocolVersion })
    const session = daemonSessionFrom(redeemed)
    // The daemon refuses a greeting whose kind is not the credential's, and
    // this tab greets as input.client. A credential bound to another kind
    // would report paired here and then fail at the session, so it is not
    // kept. The daemon already spent the code and enrolled the device.
    const { binding } = devicePairResultSchema.parse(redeemed).device
    const bound = binding.kind === "client" ? binding.client : undefined
    if (bound !== input.client) throw new DeviceKindMismatchError(bound, input.client)
    return session
  } finally {
    client.disconnect()
  }
}

export class DeviceKindMismatchError extends Error {
  readonly bound: ClientKind | undefined
  readonly expected: ClientKind

  constructor(bound: ClientKind | undefined, expected: ClientKind) {
    super(`The code paired ${bound ?? "a device that is not a client"}, and this browser greets as ${expected}`)
    this.name = "DeviceKindMismatchError"
    this.bound = bound
    this.expected = expected
  }
}

function kindMismatchOutcome(cause: DeviceKindMismatchError, host: string): Omit<PairingOutcome, "action"> {
  const expected = kindNames[cause.expected]
  return {
    tone: "danger",
    pill: "not kept",
    title: cause.bound ? `This code is for ${kindNames[cause.bound].device}` : "This code is not for a browser",
    mono: `pair.refused · kind_mismatch · code ${cause.bound ?? "none"}, browser ${cause.expected}`,
    body: `This browser counts as ${expected.device}. On ${host}, show a ${expected.code} under Settings, Phone and tablet. The code was used, so unpair the extra device under Machines.`,
  }
}

// What the daemon said, as the page draws it. Every bad code gets one uniform
// refusal from the daemon on purpose, so the page cannot say whether a code
// expired, was spent, or came from another machine, and does not guess.
export function pairingOutcomeFor(cause: unknown, host: string): Omit<PairingOutcome, "action"> {
  if (cause instanceof DeviceKindMismatchError) return kindMismatchOutcome(cause, host)
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
    if (cause.code === daemonAuthenticationErrorCode && cause.message === codeRefusalMessage) {
      return { tone: "plain", pill: "refused", title: "That code was refused", mono: "pair.refused · works once · 180s", body: `It may have expired or been used already. Show another on ${host}, under Settings, Phone and tablet.` }
    }
    return { tone: "danger", pill: "refused", title: "The daemon refused pairing", mono: `pair.refused · ${cause.code}`, body: cause.message }
  }
  if (cause instanceof CodeShapeError) {
    return { tone: "plain", pill: "not sent", title: `That is not a ${codeNameFor(cause.expected)}`, mono: "word-word-word-00", body: cause.message }
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
