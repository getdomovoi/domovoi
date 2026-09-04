import type { FleetHealth, FleetMachine } from "@getdomovoi/protocol"

export type MachineRow = {
  id: string
  label: string
  platform: string
  health: "ok" | "busy" | "gone"
  // Only states that need something from a person carry a badge. A healthy
  // machine saying "healthy" is noise on a phone.
  badge: string | undefined
}

const badges: Partial<Record<FleetHealth, string>> = {
  degraded: "Not responding",
  unreachable: "Unreachable",
  "version-mismatch": "Update this device",
  "upgrade-required": "Upgrade needed",
  reconnecting: "Reconnecting",
}

const gone = new Set<FleetHealth>(["unreachable", "degraded"])
const busy = new Set<FleetHealth>(["reconnecting", "version-mismatch", "upgrade-required"])

export function machineRows(fleet: FleetMachine[]): MachineRow[] {
  return fleet.map((machine) => ({
    id: machine.id,
    label: machine.label,
    platform: `${machine.platform} · ${machine.arch} · ${machine.version}`,
    health: gone.has(machine.health) ? "gone" : busy.has(machine.health) ? "busy" : "ok",
    badge: badges[machine.health],
  }))
}
