import { selectTransport, type FleetMachine } from "@getdomovoi/protocol"

import type { MachineCredentials } from "./machine-credentials.js"

export type MachineConnection = {
  call: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>
  close: () => void
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

function leavesThisMachine(endpoint: string): boolean {
  if (endpoint.startsWith("wss://")) return false
  try {
    return !loopbackHosts.has(new URL(endpoint).hostname)
  } catch {
    return true
  }
}

// Reaching another machine needs three things this daemon already has: what the
// fleet says about it, the credential pairing left here, and the transport
// order the protocol defines.
export function createMachineDialer(input: {
  machines: () => FleetMachine[]
  sourceMachineId: () => string
  credentials: MachineCredentials | undefined
  open: (input: {
    endpoint: string
    expectedMachineId: string
    machineId: string
    credential: string
    signal?: AbortSignal
  }) => Promise<MachineConnection>
  relayAvailable?: boolean
}): (machineId: string, signal?: AbortSignal) => Promise<MachineConnection> {
  return async (machineId: string, signal?: AbortSignal) => {
    const machine = input.machines().find((candidate) => candidate.id === machineId)
    if (!machine) throw new Error("That machine cannot be reached")

    const credential = input.credentials?.forMachine(machineId)
    if (!credential) throw new Error("That machine has to be paired again")

    const transport = selectTransport(machine.transports, {
      ...(input.relayAvailable === undefined ? {} : { relayAvailable: input.relayAvailable }),
    })
    if (!transport) throw new Error("That machine advertises no usable transport")

    // A credential must never cross a network in the clear. An endpoint is not
    // proof of where it leads: nothing stops a machine elsewhere from
    // advertising a loopback address, so plaintext is dialed only when the
    // machine and the transport both say this is the local machine.
    const staysHere = transport.kind === "local"
      && machine.connection === "local"
      && !leavesThisMachine(transport.endpoint)
    if (!transport.endpoint.startsWith("wss://") && !staysHere) {
      throw new Error("Refusing to authenticate over an unencrypted connection")
    }

    return input.open({
      endpoint: transport.endpoint,
      expectedMachineId: machine.id,
      // The credential selects the target, but the handshake identifies the
      // caller. Sending the target id here makes both ends appear to be the
      // same machine and defeats source-bound transfer authorization.
      machineId: input.sourceMachineId(),
      credential,
      ...(signal ? { signal } : {}),
    })
  }
}
