import { fleetHealthSchema, type FleetMachine } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { machineRows } from "./machine-rows"

const machine: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  protocolVersion: "0.2.0",
  transports: [],
  heartbeat: { state: "online", lastSeenAt: "2026-09-04T12:00:00.000Z" },
  health: "healthy",
  self: false,
}

describe("machineRows", () => {
  it("badges only the states that want something from a person", () => {
    expect(machineRows([machine])[0]?.badge).toBeUndefined()
    expect(machineRows([{ ...machine, health: "unreachable" }])[0])
      .toMatchObject({ health: "gone", badge: "Unreachable" })
  })

  it("classifies every health the daemon can report", () => {
    for (const health of fleetHealthSchema.options) {
      const row = machineRows([{ ...machine, health }])[0]
      expect(row?.health).toBeDefined()
      expect(row?.platform).not.toContain("undefined")
    }
  })

  it("tells the operator to update this device on a version mismatch", () => {
    // version-mismatch means the remote is ahead, so the phone is the old one.
    expect(machineRows([{ ...machine, health: "version-mismatch" }])[0]?.badge)
      .toBe("Update this device")
  })
})
