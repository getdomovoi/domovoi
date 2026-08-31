import { describe, expect, it } from "vitest"

import {
  fleetMachineFactsSchema,
  fleetMachineSchema,
  fleetSnapshotSchema,
  machineHeartbeatState,
  maximumFleetMachines,
  staleHeartbeatMs,
  offlineHeartbeatMs,
} from "./fleet.js"

const machine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local" as const,
  capabilities: ["sessions", "terminals"],
  heartbeat: { state: "online" as const, lastSeenAt: "2026-08-31T12:00:00.000Z" },
  self: true,
}

describe("fleetMachineSchema", () => {
  it("accepts a described machine", () => {
    expect(fleetMachineSchema.parse(machine)).toEqual(machine)
  })

  it("rejects an identifier that is not a machine identity", () => {
    expect(fleetMachineSchema.safeParse({ ...machine, id: "laptop" }).success).toBe(false)
  })

  it("rejects an unknown capability", () => {
    expect(fleetMachineSchema.safeParse({
      ...machine,
      capabilities: ["mine-bitcoin"],
    }).success).toBe(false)
  })

  it("rejects duplicate capabilities", () => {
    expect(fleetMachineSchema.safeParse({
      ...machine,
      capabilities: ["sessions", "sessions"],
    }).success).toBe(false)
  })

  it("rejects unknown fields so facts stay described", () => {
    expect(fleetMachineSchema.safeParse({ ...machine, secret: "x" }).success).toBe(false)
  })

  it("requires a heartbeat timestamp with an offset", () => {
    expect(fleetMachineSchema.safeParse({
      ...machine,
      heartbeat: { state: "online", lastSeenAt: "not-a-time" },
    }).success).toBe(false)
  })
})

describe("fleetMachineFactsSchema", () => {
  it("describes a machine without its observed heartbeat", () => {
    const { heartbeat: _heartbeat, self: _self, ...facts } = machine
    expect(fleetMachineFactsSchema.parse(facts)).toEqual(facts)
  })

  it("rejects reported facts that carry a heartbeat", () => {
    expect(fleetMachineFactsSchema.safeParse(machine).success).toBe(false)
  })

  it("rejects duplicate capabilities", () => {
    const { heartbeat: _heartbeat, self: _self, ...facts } = machine
    expect(fleetMachineFactsSchema.safeParse({
      ...facts,
      capabilities: ["sessions", "sessions"],
    }).success).toBe(false)
  })
})

describe("fleetSnapshotSchema", () => {
  it("rejects two machines sharing an identifier", () => {
    expect(fleetSnapshotSchema.safeParse({ machines: [machine, machine] }).success).toBe(false)
  })

  it("rejects more than one machine claiming to be this daemon", () => {
    expect(fleetSnapshotSchema.safeParse({
      machines: [machine, { ...machine, id: `machine-${"b".repeat(32)}` }],
    }).success).toBe(false)
  })

  it("accepts one local machine beside remote machines", () => {
    const remote = {
      ...machine,
      id: `machine-${"b".repeat(32)}`,
      self: false,
      connection: "tailnet" as const,
    }
    expect(fleetSnapshotSchema.parse({ machines: [machine, remote] }).machines).toHaveLength(2)
  })

  it("bounds the registry", () => {
    const machines = Array.from({ length: maximumFleetMachines + 1 }, (_unused, index) => ({
      ...machine,
      id: `machine-${index.toString(16).padStart(32, "0")}`,
      self: false,
    }))
    expect(fleetSnapshotSchema.safeParse({ machines }).success).toBe(false)
  })
})

describe("machineHeartbeatState", () => {
  it("reports a recent contact as online", () => {
    expect(machineHeartbeatState(1_000, 1_000)).toBe("online")
  })

  it("reports a machine that missed its heartbeat window as stale", () => {
    expect(machineHeartbeatState(1_000, 1_000 + staleHeartbeatMs + 1)).toBe("stale")
  })

  it("reports a long silence as offline", () => {
    expect(machineHeartbeatState(1_000, 1_000 + offlineHeartbeatMs + 1)).toBe("offline")
  })

  it("treats a timestamp from the future as online", () => {
    expect(machineHeartbeatState(5_000, 1_000)).toBe("online")
  })
})
