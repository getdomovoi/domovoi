import type { FleetEntry, FleetHealth, FleetMachine, FleetPendingOperation } from "@getdomovoi/protocol"

export type MachineRow = {
  id: string
  label: string
  platform: string
  health: "ok" | "busy" | "gone"
  // Only states that need something from a person carry a badge. A healthy
  // machine saying "healthy" is noise on a phone.
  badge: string | undefined
  // A sentence where a badge alone would mislead: the two credential states
  // have different remedies, and a lifecycle row has no facts to show.
  note: string | undefined
}

// Every health the daemon can report has a badge decision here, undefined
// included, so a state added to the protocol fails to compile until the phone
// decides what to say about it.
const badges: Record<FleetHealth, string | undefined> = {
  healthy: undefined,
  degraded: "Not responding",
  unreachable: "Unreachable",
  "version-mismatch": "Update this device",
  "upgrade-required": "Upgrade needed",
  reconnecting: "Reconnecting",
  "pairing-required": "Pair again",
  "credential-store-unavailable": "Keychain unavailable",
}

const tones: Record<FleetHealth, MachineRow["health"]> = {
  healthy: "ok",
  reconnecting: "busy",
  degraded: "gone",
  unreachable: "gone",
  "version-mismatch": "busy",
  "upgrade-required": "busy",
  // The target answered and refused, so the machine is as gone as unreachable
  // until someone pairs it again from the daemon, not from this phone.
  "pairing-required": "gone",
  // Nothing was presented, so nothing is known about the target yet.
  "credential-store-unavailable": "busy",
}

const notes: Record<FleetHealth, ((label: string) => string) | undefined> = {
  healthy: undefined,
  reconnecting: undefined,
  degraded: undefined,
  unreachable: undefined,
  "version-mismatch": undefined,
  "upgrade-required": undefined,
  "pairing-required": (label) =>
    `${label} refused the credential the daemon holds for it. Pair it again from the daemon to restore it.`,
  "credential-store-unavailable": (label) =>
    `The daemon's keychain could not be read, so nothing was presented to ${label}. Pairing again would not fix it.`,
}

const pendingWord: Record<FleetPendingOperation["operation"], string> = {
  enroll: "Enrolling",
  forget: "Forgetting",
}

function shortMachineId(machineId: string): string {
  return `${machineId.slice(0, 16)}…`
}

function machineRow(machine: FleetMachine): MachineRow {
  return {
    id: machine.id,
    label: machine.label,
    platform: `${machine.platform} · ${machine.arch} · ${machine.version}`,
    health: tones[machine.health],
    badge: badges[machine.health],
    note: notes[machine.health]?.(machine.label),
  }
}

// One row per lifecycle kind. Each case returns, so a kind the protocol adds
// later fails to compile here instead of rendering nothing.
function entryRow(entry: FleetEntry): MachineRow {
  switch (entry.kind) {
    case "machine":
      return machineRow(entry.machine)
    case "pending":
      return {
        id: entry.machineId,
        label: pendingWord[entry.operation],
        platform: shortMachineId(entry.machineId),
        health: "busy",
        badge: "In progress",
        note: "This daemon resumes it on its own.",
      }
    case "unenrolled":
      return {
        id: entry.machineId,
        label: "Never enrolled",
        platform: shortMachineId(entry.machineId),
        health: "gone",
        badge: "Unenrolled",
        note: "A credential exists but this machine was never enrolled. Pair it again from the daemon to enroll it.",
      }
  }
}

export function machineRows(entries: FleetEntry[]): MachineRow[] {
  return entries.map(entryRow)
}
