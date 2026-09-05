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

// Four dials at once keeps a large fleet from turning one refresh into a
// burst of connections, timers, and credential reads on both ends.
export const defaultFleetInventoryConcurrency = 4

// Online machines answer soonest, so they are asked first. One that is still
// reconnecting is asked after them, and a stale one last.
function dialOrder(machine: FleetMachine): number {
  const heartbeat = machine.heartbeat.state === "online" ? 0 : 2
  return heartbeat + (machine.health === "reconnecting" ? 1 : 0)
}

function cancellation(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("Fleet inventory refresh cancelled", "AbortError")
}

// Asking a paired daemon for its inventory moves metadata, never files, so the
// comparison stays inside the promise that skills are not distributed to other
// machines. A machine the menu would refuse is never dialed here either, and a
// machine that answers nothing is reported rather than dropped. The dial is
// handed the refresh's own signal, so cancelling the refresh cancels the
// connection it was waiting on and not only the answer.
export async function collectFleetInventories(input: {
  local: SkillInventory
  fleet: readonly FleetMachine[] | null
  open: (machine: FleetMachine, signal: AbortSignal) => Promise<FleetInventoryReader>
  signal?: AbortSignal
  concurrency?: number
}): Promise<SkillInventorySource[]> {
  const concurrency = input.concurrency ?? defaultFleetInventoryConcurrency
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Fleet inventory concurrency must be a positive whole number")
  }
  const signal = input.signal ?? new AbortController().signal
  const targets = fleetInventoryTargets(input.fleet)
  const queue = targets
    .map((machine, index) => ({ machine, index }))
    .sort((left, right) => dialOrder(left.machine) - dialOrder(right.machine) || left.index - right.index)
  const gathered: SkillInventorySource[] = []

  const collect = async (machine: FleetMachine): Promise<SkillInventorySource> => {
    const selection = machineSelection(machine)
    if (!selection.selectable) return { state: "unreachable", machine: inventoryMachineFor(machine) }

    let reader: FleetInventoryReader | undefined
    try {
      reader = await input.open(machine, signal)
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
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next && !signal.aborted; next = queue.shift()) {
      gathered[next.index] = await collect(next.machine)
    }
  })
  await Promise.all(workers)
  if (signal.aborted) throw cancellation(signal)

  return [{ state: "available", inventory: input.local }, ...gathered]
}
