import { z } from "zod"

import { heartbeatStateSchema } from "./fleet.js"

export const fleetConnectionStateSchema = z.enum([
  "connected",
  "reconnecting",
  "disconnected",
])

// Ordered from best to worst so a reader can see what each state displaces.
export const fleetHealthSchema = z.enum([
  "healthy",
  "reconnecting",
  "degraded",
  "unreachable",
  "version-mismatch",
  "upgrade-required",
])

export const protocolCompatibilitySchema = z.enum([
  "compatible",
  "machine-behind",
  "machine-ahead",
])

export type FleetConnectionState = z.infer<typeof fleetConnectionStateSchema>
export type FleetHealth = z.infer<typeof fleetHealthSchema>
export type ProtocolCompatibility = z.infer<typeof protocolCompatibilitySchema>

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/

function readVersion(version: string): [number, number, number] {
  const parsed = versionPattern.exec(version)
  if (!parsed) throw new Error("Protocol version is malformed")
  return [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
}

// Through 0.x the daemon, protocol, and clients ship as one release unit, so a
// minor difference is breaking and only the patch may differ.
export function protocolCompatibility(
  machineVersion: string,
  clientVersion: string,
): ProtocolCompatibility {
  const [machineMajor, machineMinor] = readVersion(machineVersion)
  const [clientMajor, clientMinor] = readVersion(clientVersion)
  if (machineMajor === clientMajor && machineMinor === clientMinor) return "compatible"
  if (machineMajor !== clientMajor) {
    return machineMajor > clientMajor ? "machine-ahead" : "machine-behind"
  }
  return machineMinor > clientMinor ? "machine-ahead" : "machine-behind"
}

export function fleetMachineHealth(input: {
  heartbeat: z.infer<typeof heartbeatStateSchema>
  connection: FleetConnectionState
  protocolVersion: string
  clientProtocolVersion: string
}): FleetHealth {
  // A version problem does not resolve by waiting, so it is reported ahead of
  // reachability, which may recover on its own.
  const compatibility = protocolCompatibility(input.protocolVersion, input.clientProtocolVersion)
  if (compatibility === "machine-behind") return "upgrade-required"
  if (compatibility === "machine-ahead") return "version-mismatch"

  if (input.connection === "reconnecting") return "reconnecting"
  if (input.heartbeat === "offline") return "unreachable"
  if (input.heartbeat === "stale") return "degraded"
  return "healthy"
}
