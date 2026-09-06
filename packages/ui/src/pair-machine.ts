import {
  fleetDirectEndpointSchema,
  fleetEntryMachineId,
  pairingCodeSchema,
  type FleetEnrollParams,
  type FleetEnrollRefusal,
  type FleetEnrollResult,
  type FleetSnapshot,
} from "@getdomovoi/protocol"

import type { Deadline } from "./deadline.js"
import { isLoopbackEndpoint } from "./transport-dial.js"

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

// A pending enrollment has no descriptor yet: the daemon resumes it and the
// fleet shows the row until it lands, so there is no label to report.
export type PairedMachine =
  | { outcome: "enrolled"; machineId: string; label: string; fleet: FleetSnapshot }
  | { outcome: "pending"; machineId: string; fleet: FleetSnapshot }

// Every refusal the protocol can name, in this build's words. A reason added
// to the protocol has to decide its copy here before it compiles.
export const enrollRefusalMessage: Record<FleetEnrollRefusal, string> = {
  "pairing-refused": "That machine refused the pairing code",
  "target-unreachable": "That machine could not be reached at that address",
  "protocol-mismatch": "That machine speaks a different protocol version, so update Domovoi on whichever is older",
  "identity-mismatch": "That machine is not the one this pairing expected",
  "target-description-invalid": "That machine described itself in a way this build cannot read",
  "self-enrollment": "That address is this machine",
  "credential-store-unavailable": "The keychain on this machine could not be written, so nothing was paired",
  "fleet-unavailable": "This daemon has no fleet store, so it cannot pair another machine",
  "fleet-limit": "This fleet already holds as many machines as it can",
  "operation-in-progress": "An enrollment or a forget for that machine is still finishing",
}

// Parsed rather than prefix-matched, so an address with no machine behind it
// never reaches the daemon, and a pairing code, a credential in its own right
// for the few minutes it lives, never crosses a network in the clear.
function checkedEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new MachinePairingError("A machine address must be a WebSocket URL")
  }
  if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new MachinePairingError("A machine address must be a WebSocket URL")
  }
  if (parsed.protocol === "ws:" && !isLoopbackEndpoint(endpoint)) {
    throw new MachinePairingError("Refusing to send a pairing code over an unencrypted connection")
  }
  if (!fleetDirectEndpointSchema.safeParse(endpoint).success) {
    throw new MachinePairingError("A machine address cannot carry credentials, a query or a fragment")
  }
  return endpoint
}

// Pairing is one call: the daemon claims the credential, greets the target on
// its own connection and stores what came back. Nothing here ever holds a
// machine credential, and the target's facts arrive through the daemon's
// fleet rather than through a greeting this client performs.
export async function pairMachine(input: {
  request: PairMachineRequest
  deadline: Deadline
  enroll: (params: Omit<FleetEnrollParams, "client">, deadline: Deadline) => Promise<FleetEnrollResult>
}): Promise<PairedMachine> {
  const endpoint = checkedEndpoint(input.request.endpoint)
  if (!pairingCodeSchema.safeParse(input.request.code).success) {
    throw new MachinePairingError("A pairing code looks like hearth-quiet-ember-42")
  }

  let result: FleetEnrollResult
  try {
    result = await input.enroll({
      endpoint,
      code: input.request.code,
      sourceDeviceLabel: input.request.label,
    }, input.deadline)
  } catch (error) {
    // The daemon's own refusal is kept, but nothing else: a transport or
    // validation error can quote the request, and the request carries the code.
    const message = error instanceof Error && !error.message.includes(input.request.code)
      ? error.message
      : "Pairing was refused"
    throw new MachinePairingError(message)
  }

  switch (result.outcome) {
    case "refused":
      throw new MachinePairingError(enrollRefusalMessage[result.reason])
    case "pending":
      return { outcome: "pending", machineId: result.operation.machineId, fleet: result.fleet }
    case "enrolled": {
      const entry = result.fleet.entries.find((candidate) => fleetEntryMachineId(candidate) === result.machineId)
      if (entry?.kind !== "machine") {
        throw new MachinePairingError("The daemon enrolled the machine but did not describe it")
      }
      return { outcome: "enrolled", machineId: result.machineId, label: entry.machine.label, fleet: result.fleet }
    }
  }
}
