import { decodePairingPayload, deviceCurrentResultSchema, deviceLabelSchema, devicePairResultSchema, maximumPairedDeviceLabelLength, pairingCodeSchema, pairingPayloadPrefix, protocolVersion } from "@getdomovoi/protocol"

import type { CredentialStore } from "./credentials.js"
import { reconcileRelayPin } from "./relay-pin.js"
import { DaemonRefusedError, DaemonUnreachableError } from "./rpc.js"
import { terminalSafe } from "./terminal-text.js"

export class PairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingError"
  }
}

export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// The sentences this flow prints. One place, so a reworded line is one edit.
// A label, a reason or an error message came from the daemon, the keychain or
// the socket, so each is drawn through terminalSafe. The client kind is a
// validated enum.
const copy = {
  notACode: "That is not a pairing code. Paste the line 'domovoid pair --client cli' printed, or the code alone.",
  issuedForAnother: (client: string, label: string) => `This code was issued for a ${client}, so nothing was kept. ${revoke(label)}`,
  // Both run after the code was spent: the daemon lists the device under its
  // label with nobody holding its token, and it counts toward the device
  // limit, so the person is told to revoke it before showing another code.
  helloRefused: (reason: string | undefined, label: string) => `The daemon refused the credential this code minted${reason === undefined ? "" : ` (${terminalSafe(reason)})`}, so nothing was kept. ${revoke(label)}`,
  notStored: (reason: string, label: string) => `The credential works but could not be stored (${terminalSafe(reason)}), so nothing was kept. ${revoke(label)}`,
  relayNotEnrolled: (reason: string) => `The daemon is paired, but its relay identity was not enrolled (${terminalSafe(reason)}). Relay use will need pairing again.`,
  unreadableReply: "The daemon answered with something this client could not read.",
}

function revoke(label: string): string {
  return `Revoke "${terminalSafe(label)}" on the machine, then show a code for the cli.`
}

// The label is bounded here, before anything is sent: the daemon admits the
// claim before it reads the label, so an over-long one would cost one of the
// three pairing admissions a source gets per minute and the code it carried.
// The bound is the wire's, 1 to 128 UTF-16 units after trimming.
export function deviceLabelProblem(label: string, source: "--label" | "hostname"): string | undefined {
  if (deviceLabelSchema.safeParse(label).success) return undefined
  if (source === "hostname") return `This machine's hostname does not fit a device label (1 to ${maximumPairedDeviceLabelLength} characters), so pass --label <device label>`
  return label.trim().length === 0 ? "--label needs a name the daemon can show" : `--label takes at most ${maximumPairedDeviceLabelLength} characters`
}

// The daemon side of pairing is `domovoid pair --client cli`, run where the
// daemon runs; its --label is optional and only a suggested name, since this
// half's own --label names the device. It prints a one-time code, bare on a
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
      if (error instanceof DaemonRefusedError) throw new PairingError(terminalSafe(error.message))
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
  // The label the daemon recorded when the code was redeemed, so a failure
  // after that point can name the device it left on the daemon.
  label: string
  store: CredentialStore
  // Opens an authenticated connection and returns a caller for it; the
  // daemon's hello is where a wrong or revoked bearer is refused.
  connect: (authToken: string) => Promise<{ call: RpcCall; close(): void }>
}): Promise<{ deviceId: string; machineId: string; relayPin: "enrolled" | "recovered" | "trusted" | "unavailable" }> {
  let connection
  try {
    connection = await input.connect(input.credential)
  } catch (error) {
    // A daemon that stopped answering between the redeem and this hello is
    // still unreachable, not a refusal, so it keeps its class and exit code.
    // Its messages name the endpoint and the method, never the request.
    if (error instanceof DaemonUnreachableError) throw error
    // The daemon's refusal is kept; anything that could quote the request is
    // not, because the request carries the bearer.
    const reason = error instanceof Error && !error.message.includes(input.credential) ? error.message : undefined
    throw new PairingError(copy.helloRefused(reason, input.label))
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
        endpoint: input.endpoint, deviceId: current.deviceId, machineId: current.machineId, token: input.credential, label: input.label,
        ...(previous?.relayPin !== undefined && previous.relayPin.identity.machineId === current.machineId ? { relayPin: previous.relayPin } : {}),
      }))
    } catch (error) {
      throw new PairingError(copy.notStored(error instanceof Error ? error.message : String(error), input.label))
    }
    // The bearer just proved this daemon is the one being paired, so what it
    // publishes now is the identity this client pins. A daemon without relay
    // provisioning has nothing to publish; the pairing stands without a pin.
    let relayPin: "enrolled" | "recovered" | "trusted" | "unavailable"
    try {
      relayPin = await reconcileRelayPin({ store: input.store, endpoint: input.endpoint, machineId: current.machineId, call: connection.call })
    } catch (error) {
      // A daemon lost here is not passed through as unreachable: the credential
      // is already stored, so exit 3's "nothing was sent" would be false, and
      // a script that re-pairs on 3 would spend another code and leave another
      // device on the daemon. The line below says what stands and what does not.
      throw new PairingError(copy.relayNotEnrolled(error instanceof Error ? error.message : String(error)))
    }
    return { deviceId: current.deviceId, machineId: current.machineId, relayPin }
  } finally {
    connection.close()
  }
}

// The success line names the endpoint the record is keyed by, because a
// pasted payload chose it and nothing else shows it. Later commands dial the
// default unless told otherwise, so an endpoint that is not the default comes
// with the flag they need.
// The ids and label are the daemon's and the endpoint came from a pasted
// payload or --daemon, so each is drawn through terminalSafe.
export function renderPaired(input: { machineId: string; endpoint: string; label: string; deviceId: string; where: CredentialStore["where"]; defaultEndpoint: string }): string {
  const endpoint = terminalSafe(input.endpoint)
  const lines = [`Paired with ${terminalSafe(input.machineId)} at ${endpoint} as ${terminalSafe(input.label)} (cli), device ${terminalSafe(input.deviceId)}. Credential stored in the ${input.where}.`]
  if (input.endpoint !== input.defaultEndpoint) lines.push(`The default daemon is ${input.defaultEndpoint}, so later commands need --daemon ${endpoint}.`)
  return `${lines.join("\n")}\n`
}
