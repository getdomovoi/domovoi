import type { FleetMachine, TransportCandidate } from "@getdomovoi/protocol"

import { isLoopbackEndpoint } from "./transport-dial.js"
import { MachineOpenError, openMachine } from "./open-machine.js"

export type MachineTarget = {
  machineId: string
  endpoint: string
  credential: string
}

export async function resolveMachineTarget(input: {
  machine: FleetMachine
  readCredential: (machineId: string) => Promise<string>
  connect: (input: { candidates: TransportCandidate[]; credential: string }) => Promise<{
    transport: TransportCandidate
    close: () => void
  }>
  wait: (ms: number) => Promise<void>
}): Promise<MachineTarget> {
  let credential: string | undefined
  const opened = await openMachine({
    machine: input.machine,
    readCredential: async (machineId) => {
      credential = await input.readCredential(machineId)
      return credential
    },
    connect: input.connect,
    wait: input.wait,
  })

  // The probe proved the machine answers. The shell opens its own connection
  // to it, so this one is closed however the rest of this turns out.
  try {
    const endpoint = opened.transport.endpoint
    if (!endpoint.startsWith("wss://") && !isLoopbackEndpoint(endpoint)) {
      throw new MachineOpenError("That machine answered on an address this client cannot use")
    }
    if (credential === undefined) {
      throw new MachineOpenError("That machine has to be paired again")
    }
    return { machineId: input.machine.id, endpoint, credential }
  } finally {
    opened.close()
  }
}
