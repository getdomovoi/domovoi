import { deviceLabelSchema, devicePairResultSchema, rpcResponseSchema, type PairingPayload } from "@getdomovoi/protocol"

import { protocolVersionForClient } from "./protocol-facts"

// Spending a pairing code is one call on a socket that holds no credential
// yet, so it does not go through DaemonConnection: there is nothing to
// authenticate with until this returns, and the socket is closed either way.
// The code is spent whether or not this reply arrives, so a failure here means
// scanning a fresh code rather than retrying this one.

export type PairedCredential = { url: string; token: string }


const redeemDeadlineMs = 10_000

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
): Promise<PairedCredential> {
  const named = deviceLabelSchema.safeParse(label.trim())
  if (!named.success) return Promise.reject(new PairingRefusedError("Give this phone a name the machine can show."))
  return new Promise<PairedCredential>((resolve, reject) => {
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
      if ("error" in message) {
        // The daemon refuses every bad code the same way on purpose, so this
        // says what to do rather than guessing which part was wrong.
        settle(() => reject(new PairingRefusedError("The machine would not take this code. It may already have been used. Show a fresh one and scan again.")))
        return
      }
      const parsed = devicePairResultSchema.safeParse("result" in message ? message.result : undefined)
      if (!parsed.success) {
        settle(() => reject(new PairingRefusedError("The machine answered with something this phone could not read.")))
        return
      }
      settle(() => resolve({ url: payload.url, token: parsed.data.token }))
    }
    socket.onerror = () => settle(() => reject(new PairingRefusedError("This phone could not reach the machine at that address.")))
    socket.onclose = () => settle(() => reject(new PairingRefusedError("The machine closed the connection before pairing finished.")))
  })
}
