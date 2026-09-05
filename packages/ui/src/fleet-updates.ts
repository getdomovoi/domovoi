import type { FleetEntry, FleetMachine } from "@getdomovoi/protocol"

import { fleetMachines } from "./fleet-entries.js"

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/

function readVersion(version: string): [number, number, number] | undefined {
  const parsed = versionPattern.exec(version)
  if (!parsed) return undefined
  return [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
}

function isBehind(left: [number, number, number], right: [number, number, number]): boolean {
  for (let part = 0; part < 3; part += 1) {
    if (left[part]! !== right[part]!) return left[part]! < right[part]!
  }
  return false
}

/**
 * The newest daemon anyone in the fleet is running. A machine whose version
 * Domovoi cannot read is ignored rather than treated as oldest or newest: an
 * unreadable version is an unknown, and a badge is a claim.
 */
export function newestFleetVersion(entries: readonly FleetEntry[]): string | undefined {
  let newest: { version: string; parts: [number, number, number] } | undefined
  for (const machine of fleetMachines(entries)) {
    const parts = readVersion(machine.version)
    if (!parts) continue
    if (!newest || isBehind(newest.parts, parts)) newest = { version: machine.version, parts }
  }
  return newest?.version
}

/**
 * The version a machine could move to, or undefined when it is current. This
 * is a patch-level fact and separate from protocol compatibility: a machine can
 * be one patch behind and still speak the same protocol, which is why this does
 * not reuse `fleetMachineHealth`.
 */
export function fleetUpdateAvailable(
  machine: FleetMachine,
  entries: readonly FleetEntry[],
): string | undefined {
  const current = readVersion(machine.version)
  if (!current) return undefined
  const newest = newestFleetVersion(entries)
  const newestParts = newest ? readVersion(newest) : undefined
  if (!newest || !newestParts) return undefined
  return isBehind(current, newestParts) ? newest : undefined
}
