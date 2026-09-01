import { machineCredentialMissingErrorCode, type FleetMachine, type TransportCandidate } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"

import { machineSelection } from "./machine-selection.js"
import { reconnectMachine } from "./machine-reconnect.js"

export class MachineOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachineOpenError"
  }
}

export async function openMachine<Connection>(input: {
  machine: FleetMachine
  readCredential: (machineId: string) => Promise<string>
  connect: (input: { candidates: TransportCandidate[]; credential: string }) => Promise<Connection>
  wait: (ms: number) => Promise<void>
  attempts?: number
}): Promise<Connection> {
  // The menu and this path answer the same question, so a machine that cannot
  // be offered is never dialed, whatever asked for it.
  const selection = machineSelection(input.machine)
  if (!selection.selectable) throw new MachineOpenError(selection.reason)

  let credential: string
  try {
    credential = await input.readCredential(input.machine.id)
  } catch (error) {
    // Only the daemon's own "nothing kept for that machine" means pairing is
    // the fix. A keychain that cannot be read is a different problem, and
    // pairing again would not solve it.
    if (error instanceof DaemonRpcError && error.code === machineCredentialMissingErrorCode) {
      throw new MachineOpenError("That machine has to be paired again")
    }
    throw new MachineOpenError("The credential for that machine could not be read")
  }

  return reconnectMachine({
    connect: () => input.connect({ candidates: input.machine.transports, credential }),
    wait: input.wait,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
  })
}
