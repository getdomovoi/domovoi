import type { FleetMachine, SkillInventory, SkillInventoryMachine, SkillInventorySource } from "@getdomovoi/protocol"

import { MachineOpenError } from "./open-machine.js"
import { machineSelection } from "./machine-selection.js"

export type FleetInventoryReader = {
  inventory: () => Promise<SkillInventory>
  close: () => void
}

// A fleet member describes itself with a label; an inventory names the same
// machine. Only the fields both agree on are carried across, so a placeholder
// row never invents facts the machine did not report.
export function inventoryMachineFor(machine: FleetMachine): SkillInventoryMachine {
  return {
    id: machine.id,
    name: machine.label,
    platform: machine.platform,
    arch: machine.arch,
    version: machine.version,
  }
}

export function fleetInventoryTargets(fleet: readonly FleetMachine[] | null): FleetMachine[] {
  return (fleet ?? []).filter((machine) => !machine.self && machine.capabilities.includes("skills"))
}

// Asking a paired daemon for its inventory moves metadata, never files, so the
// comparison stays inside the promise that skills are not distributed to other
// machines. A machine the menu would refuse is never dialed here either, and a
// machine that answers nothing is reported rather than dropped.
export async function collectFleetInventories(input: {
  local: SkillInventory
  fleet: readonly FleetMachine[] | null
  open: (machine: FleetMachine) => Promise<FleetInventoryReader>
}): Promise<SkillInventorySource[]> {
  const targets = fleetInventoryTargets(input.fleet)
  const gathered = await Promise.all(targets.map(async (machine): Promise<SkillInventorySource> => {
    const selection = machineSelection(machine)
    if (!selection.selectable) return { state: "unreachable", machine: inventoryMachineFor(machine) }

    let reader: FleetInventoryReader | undefined
    try {
      reader = await input.open(machine)
      return { state: "available", inventory: await reader.inventory() }
    } catch (error) {
      return {
        state: error instanceof MachineOpenError ? "unreachable" : "unknown",
        machine: inventoryMachineFor(machine),
      }
    } finally {
      // The dial exists for one question, so the connection does not outlive it.
      try {
        reader?.close()
      } catch {
        // A connection that is already gone needs no closing.
      }
    }
  }))

  return [{ state: "available", inventory: input.local }, ...gathered]
}
