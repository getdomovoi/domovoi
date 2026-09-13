import { credentialSchema, deviceCurrentResultSchema } from "@getdomovoi/protocol"

import type { CredentialStore } from "./credentials.js"
import { reconcileRelayPin } from "./relay-pin.js"

export class PairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingError"
  }
}

export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// The daemon side of pairing is `domovoid pair --client cli`, run where the
// daemon runs: it mints a client bearer and prints it once. The pairing code
// and device.claim are the machine-enrollment path, and a credential minted
// there cannot identify as a client. So this half is: take the bearer the
// operator pasted, prove it works with an authenticated hello, then keep it.
// The bearer is read from stdin, never argv, so it stays out of shell history
// and the process table.
export function readCredential(input: string): string {
  const trimmed = input.trim()
  const fromPrintout = /Client credential:\s*(\S+)/.exec(trimmed)?.[1] ?? trimmed
  if (!credentialSchema.safeParse(fromPrintout).success) {
    throw new PairingError("That is not a client credential. Paste the line 'domovoid pair --client cli' printed, or the credential alone.")
  }
  return fromPrintout
}

export async function pairWithDaemon(input: {
  endpoint: string
  credential: string
  store: CredentialStore
  // Opens an authenticated connection and returns a caller for it; the
  // daemon's hello is where a wrong or revoked bearer is refused.
  connect: (authToken: string) => Promise<{ call: RpcCall; close(): void }>
}): Promise<{ deviceId: string; machineId: string; relayPin: "enrolled" | "recovered" | "trusted" | "unavailable" }> {
  let connection
  try {
    connection = await input.connect(input.credential)
  } catch (error) {
    // The daemon's refusal is kept; anything that could quote the request is
    // not, because the request carries the bearer.
    const message = error instanceof Error && !error.message.includes(input.credential) ? error.message : "The daemon refused this credential"
    throw new PairingError(message)
  }
  try {
    const current = deviceCurrentResultSchema.parse(await connection.call("device.current", {}))
    if (current.kind !== "client") throw new PairingError("That credential belongs to a daemon, not to a client")
    try {
      // Pairing again keeps a saved relay pin when it belongs to this same
      // machine, so a pin marked recovery-required is recovered below rather
      // than silently re-enrolled from whatever the daemon now publishes. A
      // pin for a different machine at this address is dropped on purpose.
      await input.store.update(input.endpoint, (previous) => ({
        endpoint: input.endpoint, deviceId: current.deviceId, machineId: current.machineId, token: input.credential,
        ...(previous?.relayPin !== undefined && previous.relayPin.identity.machineId === current.machineId ? { relayPin: previous.relayPin } : {}),
      }))
    } catch (error) {
      throw new PairingError(`The credential works but could not be stored (${error instanceof Error ? error.message : String(error)}). Nothing was kept.`)
    }
    // The bearer just proved this daemon is the one being paired, so what it
    // publishes now is the identity this client pins. A daemon without relay
    // provisioning has nothing to publish; the pairing stands without a pin.
    let relayPin: "enrolled" | "recovered" | "trusted" | "unavailable"
    try {
      relayPin = await reconcileRelayPin({ store: input.store, endpoint: input.endpoint, machineId: current.machineId, call: connection.call })
    } catch (error) {
      throw new PairingError(`The daemon is paired, but its relay identity was not enrolled (${error instanceof Error ? error.message : String(error)}). Relay use will need pairing again.`)
    }
    return { deviceId: current.deviceId, machineId: current.machineId, relayPin }
  } finally {
    connection.close()
  }
}
