import type { FleetHealth, FleetMachine } from "@getdomovoi/protocol"

export type MachineSelection =
  | { selectable: true }
  | { selectable: false; reason: string }

// Health answers whether a machine can be worked on, so it decides whether the
// menu offers it. A machine that is reconnecting is still coming back, so it
// stays selectable and the dial waits for it.
const refusalByHealth: Partial<Record<FleetHealth, string>> = {
  degraded: "That machine is not responding",
  unreachable: "That machine cannot be reached",
  // fleetMachineHealth maps machine-ahead to version-mismatch, so the remote is
  // the newer one. The older machine is this one, and telling the operator to
  // update the remote sent them to the wrong machine.
  "version-mismatch": "That machine speaks a newer protocol version, so update Domovoi here",
  "upgrade-required": "That machine has to be upgraded first",
}

export function machineSelection(machine: FleetMachine): MachineSelection {
  const refusal = refusalByHealth[machine.health]
  if (refusal) return { selectable: false, reason: refusal }
  // A machine with nothing to dial cannot be selected, however healthy the
  // registry believes it to be.
  if (machine.transports.length === 0) {
    return { selectable: false, reason: "That machine advertises no usable transport" }
  }
  return { selectable: true }
}
