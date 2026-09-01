import type { FleetMachine, TransportCandidate } from "@getdomovoi/protocol"

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
  } catch {
    // The daemon keeps these, so the only reason one is missing is that this
    // machine was never paired or has been forgotten.
    throw new MachineOpenError("That machine has to be paired again")
  }

  return reconnectMachine({
    connect: () => input.connect({ candidates: input.machine.transports, credential }),
    wait: input.wait,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
  })
}
