import { credentialSchema, deviceCurrentResultSchema } from "@getdomovoi/protocol"

import type { CredentialStore } from "./credentials.js"

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
}): Promise<{ deviceId: string; machineId: string }> {
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
      await input.store.save({ endpoint: input.endpoint, deviceId: current.deviceId, machineId: current.machineId, token: input.credential })
    } catch (error) {
      throw new PairingError(`The credential works but could not be stored (${error instanceof Error ? error.message : String(error)}). Nothing was kept.`)
    }
    return { deviceId: current.deviceId, machineId: current.machineId }
  } finally {
    connection.close()
  }
}
