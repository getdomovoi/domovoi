import { decodePairingPayload, deviceCurrentResultSchema, devicePairResultSchema, pairingCodeSchema, pairingPayloadPrefix, protocolVersion } from "@getdomovoi/protocol"

import type { CredentialStore } from "./credentials.js"
import { reconcileRelayPin } from "./relay-pin.js"
import { DaemonRefusedError } from "./rpc.js"

export class PairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingError"
  }
}

export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// The sentences this flow prints. One place, so a reworded line is one edit.
const copy = {
  notACode: "That is not a pairing code. Paste the line 'domovoid pair --client cli --label <device label>' printed, or the code alone.",
  issuedForAnother: (client: string, label: string) => `This code was issued for a ${client}, so nothing was kept. Revoke "${label}" on the machine, then show a code for the cli.`,
  unreadableReply: "The daemon answered with something this client could not read.",
}

// The daemon side of pairing is `domovoid pair --client cli --label <device
// label>`, run where the daemon runs. It prints a one-time code, bare on a
// daemon that cannot name its address and otherwise inside a payload that
// also carries the address to dial (ruling Q337 A: the phone's path, so there
// is one pairing flow). This half reads either, spends the code with
// device.redeemCode on a socket that holds no credential yet, proves the
// credential the daemon minted with an authenticated hello, then keeps it.
// The code is read from stdin, never argv, so it stays out of shell history
// and the process table.
export function readPairingCode(input: string): { code: string; url?: string } {
  const trimmed = input.trim()
  const payload = new RegExp(`${pairingPayloadPrefix}\\S+`).exec(trimmed)?.[0]
  if (payload !== undefined) {
    try {
      const decoded = decodePairingPayload(payload)
      return { code: decoded.code, url: decoded.url }
    } catch (error) {
      throw new PairingError(error instanceof Error ? error.message : copy.notACode)
    }
  }
  const bare = /(?:Pairing code:\s*)?(\S+)$/.exec(trimmed)?.[1]
  if (bare === undefined || !pairingCodeSchema.safeParse(bare).success) throw new PairingError(copy.notACode)
  return { code: bare }
}

export async function redeemPairingCode(input: {
  endpoint: string
  code: string
  label: string
  // Opens a connection with no hello: an unpaired socket may redeem and
  // nothing else, and the daemon refuses a hello that carries no credential.
  open: (endpoint: string) => Promise<{ call: RpcCall; close(): void }>
}): Promise<{ token: string; device: { id: string; label: string } }> {
  const connection = await input.open(input.endpoint)
  try {
    let reply: unknown
    try {
      reply = await connection.call("device.redeemCode", { code: input.code, label: input.label, protocolVersion })
    } catch (error) {
      // The daemon refuses every bad code the same way on purpose; its words
      // are kept. A transport failure keeps its own class, so the exit code
      // can say the daemon was unreachable rather than that it refused.
      if (error instanceof DaemonRefusedError) throw new PairingError(error.message)
      throw error
    }
    const parsed = devicePairResultSchema.safeParse(reply)
    if (!parsed.success) throw new PairingError(copy.unreadableReply)
    // The code decides the kind, and the daemon refuses a hello that names
    // another. A credential this client could never greet with is not kept.
    const binding = parsed.data.device.binding
    if (binding.kind !== "client" || binding.client !== "cli") {
      throw new PairingError(copy.issuedForAnother(binding.kind === "client" ? binding.client : "machine", parsed.data.device.label))
    }
    return { token: parsed.data.token, device: { id: parsed.data.device.id, label: parsed.data.device.label } }
  } finally {
    connection.close()
  }
}

export async function pairWithDaemon(input: {
  endpoint: string
  credential: string
  label?: string
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
        ...(input.label === undefined ? {} : { label: input.label }),
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
