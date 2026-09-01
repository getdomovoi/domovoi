import { describe, expect, it } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { machineSelection } from "./machine-selection.js"

const machine: FleetMachine = {
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  protocolVersion: "0.1.0",
  transports: [
    { kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true },
  ],
  health: "healthy",
  self: false,
}

describe("machineSelection", () => {
  it("offers a healthy machine", () => {
    expect(machineSelection(machine)).toEqual({ selectable: true })
  })

  it("offers a machine that is reconnecting, because it is coming back", () => {
    expect(machineSelection({ ...machine, health: "reconnecting" }))
      .toEqual({ selectable: true })
  })

  it("refuses a machine nothing can reach", () => {
    expect(machineSelection({ ...machine, health: "unreachable" }))
      .toEqual({ selectable: false, reason: "That machine cannot be reached" })
  })

  it("refuses a machine speaking another protocol", () => {
    expect(machineSelection({ ...machine, health: "version-mismatch" }))
      .toEqual({ selectable: false, reason: "That machine speaks a different protocol version" })
  })

  it("refuses a machine that has to be upgraded first", () => {
    expect(machineSelection({ ...machine, health: "upgrade-required" }))
      .toEqual({ selectable: false, reason: "That machine has to be upgraded first" })
  })

  it("refuses a machine that is not responding", () => {
    expect(machineSelection({ ...machine, health: "degraded" }))
      .toEqual({ selectable: false, reason: "That machine is not responding" })
  })

  it("refuses a machine with no transport this client may dial", () => {
    expect(machineSelection({ ...machine, transports: [] }))
      .toEqual({ selectable: false, reason: "That machine advertises no usable transport" })
  })
})
