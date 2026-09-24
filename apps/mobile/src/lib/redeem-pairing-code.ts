import {
  daemonAuthenticationErrorCode,
  devicePairingLimitErrorCode,
  deviceLabelSchema,
  devicePairResultSchema,
  protocolMismatchSchema,
  protocolVersionMismatchErrorCode,
  rpcResponseSchema,
  type ClientKind,
  type PairingPayload,
} from "@getdomovoi/protocol"

import { protocolVersionForClient, type HandheldClient } from "./protocol-facts"

// Spending a pairing code is one call on a socket that holds no credential
// yet, so it does not go through DaemonConnection: there is nothing to
// authenticate with until this returns, and the socket is closed either way.
// The code is spent whether or not this reply arrives, so a failure here means
// scanning a fresh code rather than retrying this one.

export type PairedCredential = { url: string; token: string; client: HandheldClient }

// The id the machine gave this device. It is not a secret: the machine's audit
// rows name a device by it, and the paired card shows it shortened.
export type PairedDevice = PairedCredential & { deviceId: string }

const otherKinds: Record<Exclude<ClientKind, HandheldClient>, string> = {
  desktop: "a desktop",
  web: "a web browser",
  cli: "the command line",
}

function refusal(error: { code: number, message: string, data?: unknown }): string {
  if (error.code === protocolVersionMismatchErrorCode) {
    const mismatch = protocolMismatchSchema.safeParse(error.data)
    const versions = mismatch.success
      ? `This app speaks protocol ${mismatch.data.clientProtocolVersion}; the machine speaks protocol ${mismatch.data.daemonProtocolVersion}`
      : error.message
    return `${versions}. Update whichever of the two is older. The code was not used, so it still works until it expires.`
  }
  if (error.code === devicePairingLimitErrorCode) {
    return "The machine has too many paired devices. Revoke one on the machine, then show a fresh code and scan again."
  }
  // The daemon refuses every bad code the same way on purpose, so this
  // says what to do rather than guessing which part was wrong.
  if (error.code === daemonAuthenticationErrorCode) {
    return "The machine would not take this code. It may already have been used. Show a fresh one and scan again."
  }
  return `The machine refused pairing: ${error.message}`
}


const redeemDeadlineMs = 10_000

// React Native reports socket failures as an event carrying a message, and web
// reports an event carrying nothing. Both shapes are read without trusting
// either to be present.
function socketDetail(event: unknown): string {
  if (typeof event !== "object" || event === null) return ""
  const held = event as { message?: unknown }
  return typeof held.message === "string" ? held.message : ""
}

function closeDetail(event: unknown): string {
  if (typeof event !== "object" || event === null) return ""
  const held = event as { code?: unknown, reason?: unknown }
  const code = typeof held.code === "number" ? String(held.code) : ""
  const reason = typeof held.reason === "string" && held.reason ? held.reason : ""
  return [code, reason].filter(Boolean).join(": ")
}

export class PairingRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingRefusedError"
  }
}

export function redeemPairingCode(
  payload: PairingPayload,
  label: string,
  open: (url: string) => WebSocket = (url) => new WebSocket(url),
): Promise<PairedDevice> {
  const named = deviceLabelSchema.safeParse(label.trim())
  if (!named.success) return Promise.reject(new PairingRefusedError("Give this phone a name the machine can show."))
  return new Promise<PairedDevice>((resolve, reject) => {
    const socket = open(payload.url)
    const timer = setTimeout(
      () => settle(() => reject(new PairingRefusedError("The machine did not answer. Check it is awake and on this network, then scan a fresh code."))),
      redeemDeadlineMs,
    )
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try { socket.close() } catch { /* closing a socket that never opened is not a failure */ }
      finish()
    }
    socket.onopen = () => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "device.redeemCode",
        params: { code: payload.code, label: named.data, protocolVersion: protocolVersionForClient },
      }))
    }
    socket.onmessage = (event) => {
      let received: unknown
      try { received = JSON.parse(String(event.data)) } catch { return }
      // A reply from a machine this phone has not authenticated with is
      // decided by the protocol's own schema, never by reading fields off
      // whatever arrived.
      const reply = rpcResponseSchema.safeParse(received)
      if (!reply.success) return
      const message = reply.data
      if (message.error) {
        const { error } = message
        settle(() => reject(new PairingRefusedError(refusal(error))))
        return
      }
      const parsed = devicePairResultSchema.safeParse("result" in message ? message.result : undefined)
      if (!parsed.success) {
        settle(() => reject(new PairingRefusedError("The machine answered with something this phone could not read.")))
        return
      }
      // The code decides the kind, and the daemon refuses a greeting that names
      // another. A credential this app could never greet with is not kept.
      const binding = parsed.data.device.binding
      if (binding.kind !== "client") {
        settle(() => reject(new PairingRefusedError("This code did not pair a device this app can use. Show a code for a phone or tablet.")))
        return
      }
      const client = binding.client
      if (client !== "phone" && client !== "tablet") {
        settle(() => reject(new PairingRefusedError(
          `This code was issued for ${otherKinds[client]}, so this app did not keep it. Revoke "${parsed.data.device.label}" on the machine, then show a code for a phone or tablet.`,
        )))
        return
      }
      settle(() => resolve({ url: payload.url, token: parsed.data.token, client, deviceId: parsed.data.device.id }))
    }
    // A socket that fails says "could not reach" for a name that will not
    // resolve, a route that is blocked and a certificate that was rejected
    // alike. Standing next to a phone that is the least useful thing it could
    // say, so whatever the platform reports is carried through rather than
    // replaced by a guess.
    socket.onerror = (event: unknown) => settle(() => reject(new PairingRefusedError(
      socketDetail(event)
        ? `This phone could not open a connection to the machine. The phone reported: ${socketDetail(event)}`
        : "This phone could not open a connection to the machine, and gave no reason.",
    )))
    socket.onclose = (event: unknown) => {
      const closed = closeDetail(event)
      settle(() => reject(new PairingRefusedError(
        closed
          ? `The machine closed the connection before pairing finished (${closed}).`
          : "The machine closed the connection before pairing finished.",
      )))
    }
  })
}
