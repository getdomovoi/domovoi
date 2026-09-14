import { describe, expect, it } from "vitest"

import { fleetEntrySchema, type FleetEntry, type FleetMachine } from "@getdomovoi/protocol"

import { fleetMachines, transferTargets } from "./fleet-entries.js"

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

describe("transferTargets", () => {
  const entryFor = (id: string, label: string): FleetEntry =>
    fleetEntrySchema.parse({ kind: "machine", machine: { ...machine, id, label } })

  // Every surface that offers a move derives from this. A launcher and a
  // composer restating the rule would drift about what is transferable.
  it("never offers the machine the session is already on", () => {
    const entries = [entryFor(`machine-${"a".repeat(32)}`, "macbook"), entryFor(`machine-${"b".repeat(32)}`, "thinkpad")]
    expect(transferTargets({ entries, currentMachineId: `machine-${"a".repeat(32)}` }).map((target) => target.id)).toEqual([`machine-${"b".repeat(32)}`])
    expect(transferTargets({ entries, currentMachineId: `machine-${"b".repeat(32)}` }).map((target) => target.id)).toEqual([`machine-${"a".repeat(32)}`])
  })

  it("prefers the transfer fleet when one is given, and falls back to the visible entries", () => {
    const entries = [entryFor(`machine-${"a".repeat(32)}`, "macbook"), entryFor(`machine-${"b".repeat(32)}`, "thinkpad")]
    const remote = [entryFor(`machine-${"a".repeat(32)}`, "macbook"), entryFor(`machine-${"c".repeat(32)}`, "hetzner")]
    expect(transferTargets({ entries, transferEntries: remote, currentMachineId: `machine-${"a".repeat(32)}` }).map((t) => t.id)).toEqual([`machine-${"c".repeat(32)}`])
    expect(transferTargets({ entries, currentMachineId: `machine-${"a".repeat(32)}` }).map((t) => t.id)).toEqual([`machine-${"b".repeat(32)}`])
  })

  it("offers nothing when the only machine is the one it is on", () => {
    expect(transferTargets({ entries: [entryFor(`machine-${"a".repeat(32)}`, "macbook")], currentMachineId: `machine-${"a".repeat(32)}` })).toEqual([])
  })
})
