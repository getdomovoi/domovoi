import { describe, expect, it } from "vitest"

import { fleetEntrySchema, type FleetEntry, type FleetMachine } from "@getdomovoi/protocol"

import { fleetMachines } from "./fleet-entries.js"

const machine: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.4.2",
  connection: "local",
  capabilities: ["sessions"],
  heartbeat: { state: "online", lastSeenAt: "2026-09-04T12:00:00.000Z" },
  protocolVersion: "0.4.0",
  transports: [],
  health: "healthy",
  self: true,
}

const entries: FleetEntry[] = [
  { kind: "machine", machine },
  {
    kind: "pending",
    id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
    machineId: `machine-${"b".repeat(32)}`,
    operation: "enroll",
    startedAt: "2026-09-04T12:00:00.000Z",
  },
  { kind: "unenrolled", machineId: `machine-${"c".repeat(32)}` },
]

describe("fleetMachines", () => {
  it("keeps only the entries that carry an authenticated descriptor", () => {
    expect(fleetMachines(entries)).toEqual([machine])
  })

  it("covers every entry kind the protocol describes", () => {
    const kinds = fleetEntrySchema.options.map((option) => option.shape.kind.value)
    expect(kinds.sort()).toEqual(["machine", "pending", "unenrolled"])
    expect(fleetMachines(entries)).toHaveLength(1)
  })
})
