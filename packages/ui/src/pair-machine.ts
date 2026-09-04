import { protocolVersion, type RpcParams } from "@getdomovoi/protocol"

import { clientVersion } from "./client.js"

// The greeting a freshly paired credential makes. It is a machine, not this
// desktop or browser, and omitting the protocol version would mean 0.1.0 to the
// daemon and be refused as a mismatch, so both are stated here where a test can
// read them rather than inline at the call.
export function machineHelloParams(credential: string): RpcParams<"system.hello"> {
  return { client: "machine", clientVersion, protocolVersion, authToken: credential }
}

import { machineIdSchema } from "@getdomovoi/protocol"

import { claimMachine, type ClaimConnection } from "./claim-machine.js"
import type { Deadline } from "./deadline.js"

export class MachinePairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachinePairingError"
  }
}

export type PairMachineRequest = {
  endpoint: string
  code: string
  label: string
}

export type PairedMachine = {
  machineId: string
  label: string
}

// One deadline covers the whole pairing: claiming the credential, greeting the
// machine to learn its name, and storing what came back. A stage that starts
// late gets only what the earlier stages left.
export async function pairMachine(input: {
  request: PairMachineRequest
  machineId: string
  deadline: Deadline
  open: (endpoint: string, deadline: Deadline) => Promise<ClaimConnection>
  identify: (input: { endpoint: string; credential: string; deadline: Deadline }) => Promise<{ id: string; name: string }>
  saveCredential: (input: { machineId: string; credential: string; deadline: Deadline }) => Promise<void>
}): Promise<PairedMachine> {
  const claimed = await claimMachine({
    endpoint: input.request.endpoint,
    code: input.request.code,
    label: input.request.label,
    machineId: input.machineId,
    deadline: input.deadline,
    open: input.open,
  })

  let identified: { id: string; name: string }
  try {
    identified = await input.identify({
      endpoint: input.request.endpoint,
      credential: claimed.token,
      deadline: input.deadline,
    })
  } catch {
    // Naming the machine is done over the credential, so a handshake or
    // transport failure can quote it. Only this build's own words are reported.
    throw new MachinePairingError("The machine did not name itself after pairing")
  }
  // The credential is stored under the machine's own identity, so an identity
  // this build cannot address is refused before anything is written.
  const machineId = machineIdSchema.safeParse(identified.id)
  if (!machineId.success) {
    throw new MachinePairingError("The machine reported an identity this build cannot address")
  }

  try {
    await input.saveCredential({
      machineId: machineId.data,
      credential: claimed.token,
      deadline: input.deadline,
    })
  } catch {
    // A storage failure can quote the request it was given, and the request
    // carries the credential, so only this build's own words are reported.
    throw new MachinePairingError("The machine paired but its credential could not be stored")
  }

  return { machineId: machineId.data, label: identified.name }
}
