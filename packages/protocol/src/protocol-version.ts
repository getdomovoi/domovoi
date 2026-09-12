import { z } from "zod"

import { utf16MaxLength } from "./validation.js"

// Wire compatibility is separate from the executable's buildVersion. 0.6 adds
// transfer history that older clients cannot parse; credentials stay valid.
export const protocolVersion = "0.6.0" as const
export const maximumProtocolVersionLength = 64

// Absolute end: $ alone also matches before a final newline in JavaScript.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/
export const protocolVersionSchema = z.string()
  .check(utf16MaxLength(maximumProtocolVersionLength))
  .regex(versionPattern, "Protocol version must be three canonical nonnegative integers")

export const protocolCompatibilitySchema = z.enum([
  "compatible",
  "machine-behind",
  "machine-ahead",
])
export type ProtocolCompatibility = z.infer<typeof protocolCompatibilitySchema>

function readVersion(version: string): [bigint, bigint] {
  const parsed = protocolVersionSchema.safeParse(version)
  if (!parsed.success) throw new Error("Protocol version is malformed")
  const [major, minor] = parsed.data.split(".")
  return [BigInt(major!), BigInt(minor!)]
}

// Major and minor must match, including after 1.0; only patch may differ.
// Exact integer comparison avoids rounding two distinct components together.
export function protocolCompatibility(machineVersion: string, clientVersion: string): ProtocolCompatibility {
  const [machineMajor, machineMinor] = readVersion(machineVersion)
  const [clientMajor, clientMinor] = readVersion(clientVersion)
  if (machineMajor === clientMajor && machineMinor === clientMinor) return "compatible"
  if (machineMajor !== clientMajor) return machineMajor > clientMajor ? "machine-ahead" : "machine-behind"
  return machineMinor > clientMinor ? "machine-ahead" : "machine-behind"
}

// Keep the actual peer version in parsed snapshots. The pipe only compares
// after shape and length validation, so malformed input stays a parse refusal.
export const compatibleProtocolVersionSchema = protocolVersionSchema.pipe(z.string().refine(
  (version) => protocolCompatibility(protocolVersion, version) === "compatible",
  "Protocol major and minor must match this client",
))
