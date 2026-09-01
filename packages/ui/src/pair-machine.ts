import { machineIdSchema } from "@getdomovoi/protocol"

import { claimMachine, type ClaimConnection } from "./claim-machine.js"
import type { PairMachineRequest } from "./pair-machine-dialog.js"

export class MachinePairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachinePairingError"
  }
}

export type PairedMachine = {
  machineId: string
  label: string
}

export async function pairMachine(input: {
  request: PairMachineRequest
  open: (endpoint: string) => Promise<ClaimConnection>
  identify: (input: { endpoint: string; credential: string }) => Promise<{ id: string; name: string }>
  saveCredential: (input: { machineId: string; credential: string }) => Promise<void>
}): Promise<PairedMachine> {
  const claimed = await claimMachine({
    endpoint: input.request.endpoint,
    code: input.request.code,
    label: input.request.label,
    open: input.open,
  })

  const identified = await input.identify({
    endpoint: input.request.endpoint,
    credential: claimed.token,
  })
  // The credential is stored under the machine's own identity, so an identity
  // this build cannot address is refused before anything is written.
  const machineId = machineIdSchema.safeParse(identified.id)
  if (!machineId.success) {
    throw new MachinePairingError("The machine reported an identity this build cannot address")
  }

  try {
    await input.saveCredential({ machineId: machineId.data, credential: claimed.token })
  } catch {
    // A storage failure can quote the request it was given, and the request
    // carries the credential, so only this build's own words are reported.
    throw new MachinePairingError("The machine paired but its credential could not be stored")
  }

  return { machineId: machineId.data, label: identified.name }
}
