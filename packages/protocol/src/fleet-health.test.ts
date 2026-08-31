import { describe, expect, it } from "vitest"

import {
  fleetConnectionStateSchema,
  fleetHealthSchema,
  fleetMachineHealth,
  protocolCompatibility,
} from "./fleet-health.js"

const healthy = {
  heartbeat: "online" as const,
  connection: "connected" as const,
  protocolVersion: "0.1.0",
  clientProtocolVersion: "0.1.0",
}

describe("protocolCompatibility", () => {
  it("treats an identical version as compatible", () => {
    expect(protocolCompatibility("0.1.0", "0.1.0")).toBe("compatible")
  })

  it("treats a patch difference as compatible", () => {
    expect(protocolCompatibility("0.1.4", "0.1.0")).toBe("compatible")
  })

  it("reports a machine behind the client as needing an upgrade", () => {
    expect(protocolCompatibility("0.1.0", "0.2.0")).toBe("machine-behind")
  })

  it("reports a machine ahead of the client as a mismatch the client must resolve", () => {
    expect(protocolCompatibility("0.2.0", "0.1.0")).toBe("machine-ahead")
  })

  it("treats a major difference as incompatible in either direction", () => {
    expect(protocolCompatibility("1.0.0", "0.9.0")).toBe("machine-ahead")
    expect(protocolCompatibility("0.9.0", "1.0.0")).toBe("machine-behind")
  })

  it("refuses a version it cannot read", () => {
    expect(() => protocolCompatibility("latest", "0.1.0")).toThrow("Protocol version is malformed")
  })
})

describe("fleetMachineHealth", () => {
  it("reports a reachable current machine as healthy", () => {
    expect(fleetMachineHealth(healthy)).toBe("healthy")
  })

  it("reports a stale heartbeat as degraded", () => {
    expect(fleetMachineHealth({ ...healthy, heartbeat: "stale" })).toBe("degraded")
  })

  it("reports an offline machine as unreachable", () => {
    expect(fleetMachineHealth({ ...healthy, heartbeat: "offline" })).toBe("unreachable")
  })

  it("reports an actively retrying connection as reconnecting", () => {
    expect(fleetMachineHealth({ ...healthy, connection: "reconnecting", heartbeat: "stale" }))
      .toBe("reconnecting")
  })

  it("asks for an upgrade when the machine is behind the client", () => {
    expect(fleetMachineHealth({ ...healthy, protocolVersion: "0.1.0", clientProtocolVersion: "0.2.0" }))
      .toBe("upgrade-required")
  })

  it("reports a machine ahead of the client as a version mismatch", () => {
    expect(fleetMachineHealth({ ...healthy, protocolVersion: "0.2.0", clientProtocolVersion: "0.1.0" }))
      .toBe("version-mismatch")
  })

  it("keeps reporting a version problem while the machine is unreachable", () => {
    expect(fleetMachineHealth({
      ...healthy,
      heartbeat: "offline",
      connection: "disconnected",
      protocolVersion: "0.1.0",
      clientProtocolVersion: "0.2.0",
    })).toBe("upgrade-required")
  })

  it("describes every state it can return", () => {
    for (const state of fleetHealthSchema.options) {
      expect(typeof state).toBe("string")
    }
    expect(fleetHealthSchema.options).toEqual([
      "healthy",
      "reconnecting",
      "degraded",
      "unreachable",
      "version-mismatch",
      "upgrade-required",
    ])
  })

  it("describes the connection states a client can be in", () => {
    expect(fleetConnectionStateSchema.options).toEqual([
      "connected",
      "reconnecting",
      "disconnected",
    ])
  })
})
