import { describe, expect, it } from "vitest"

import {
  fleetDirectEndpointSchema,
  fleetMachineDescriptorSchema,
  fleetMachineFactsSchema,
  fleetMachineSchema,
  fleetSnapshotSchema,
  fleetSnapshotOverflowSchema,
  machineHeartbeatState,
  machinePlatformLabel,
  maximumFleetMachines,
  staleHeartbeatMs,
  offlineHeartbeatMs,
} from "./fleet.js"

const machine = {
  id: `machine-${"a".repeat(32)}`,
  protocolVersion: "0.1.0",
  transports: [
    { kind: "local" as const, endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true as const },
  ],
  health: "healthy" as const,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local" as const,
  capabilities: ["sessions", "terminals"],
  heartbeat: { state: "online" as const, lastSeenAt: "2026-08-31T12:00:00.000Z" },
  self: true,
}
const described = <T>(value: T) => ({ kind: "machine" as const, machine: value })

describe("fleet direct endpoint normalization", () => {
  it.each(["127.0.0.1", "localhost", "[::1]", "127%2e0%2e0%2e1", "[0:0:0:0:0:0:0:1]"])(
    "accepts plaintext loopback after URL normalization: %s", (host) => {
      expect(fleetDirectEndpointSchema.safeParse(`ws://${host}:47831/rpc`).success).toBe(true)
    },
  )

  it.each(["[::ffff:127.0.0.1]", "127.0.0.1%2eexample.com"])(
    "refuses plaintext outside the normalized loopback allowlist: %s", (host) => {
      expect(fleetDirectEndpointSchema.safeParse(`ws://${host}:47831/rpc`).success).toBe(false)
    },
  )
})

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

describe("fleet machine transports", () => {
  it("preserves a source-verified route absent from target advertisements", () => {
    const remote = {
      ...machine,
      self: false,
      connection: "direct",
      transports: [{
        kind: "lan",
        endpoint: "wss://192.168.1.20:47831/rpc",
        authenticated: true,
      }],
      verifiedRoute: {
        endpoint: "wss://workshop.tailnet:443/rpc",
        lastAuthenticatedAt: "2026-09-04T12:00:00.000Z",
      },
    }
    expect(fleetMachineSchema.parse(remote)).toEqual(remote)
  })

  it("carries the endpoints a client may dial", () => {
    expect(fleetMachineSchema.parse(machine).transports).toEqual(machine.transports)
  })

  it("refuses an endpoint the dialer would reject", () => {
    expect(fleetMachineSchema.safeParse({
      ...machine,
      transports: [{ kind: "lan", endpoint: "ws://workshop.local:47831/rpc", authenticated: false }],
    }).success).toBe(false)
  })

  it("bounds how many endpoints a machine may advertise", () => {
    expect(fleetMachineSchema.safeParse({
      ...machine,
      transports: Array.from({ length: 9 }, () => machine.transports[0]),
    }).success).toBe(false)
  })
})

describe("fleet machine health", () => {
  it.each(["pairing-required", "credential-store-unavailable"])(
    "describes %s separately from reachability",
    (health) => {
      expect(fleetMachineSchema.parse({ ...machine, self: false, health }).health).toBe(health)
    },
  )
  it("requires a described health state", () => {
    const { health: _health, ...withoutHealth } = machine
    expect(fleetMachineSchema.safeParse(withoutHealth).success).toBe(false)
    expect(fleetMachineSchema.safeParse({ ...machine, health: "fine" }).success).toBe(false)
  })

  it("requires a readable protocol version", () => {
    expect(fleetMachineSchema.safeParse({ ...machine, protocolVersion: "latest" }).success)
      .toBe(false)
  })

  it("keeps health out of reported facts, because the daemon derives it", () => {
    const { heartbeat: _heartbeat, self: _self, ...facts } = machine
    expect(fleetMachineFactsSchema.safeParse(facts).success).toBe(false)
    const { health: _health, ...reportable } = facts
    expect(fleetMachineFactsSchema.parse(reportable)).toEqual(reportable)
  })
})

describe("fleetMachineFactsSchema", () => {
  it("describes a machine without its observed heartbeat", () => {
    const { heartbeat: _heartbeat, self: _self, health: _health, ...facts } = machine
    expect(fleetMachineFactsSchema.parse(facts)).toEqual(facts)
  })

  it("rejects reported facts that carry a heartbeat", () => {
    expect(fleetMachineFactsSchema.safeParse(machine).success).toBe(false)
  })

  it("rejects duplicate capabilities", () => {
    const { heartbeat: _heartbeat, self: _self, health: _health, ...facts } = machine
    expect(fleetMachineFactsSchema.safeParse({
      ...facts,
      capabilities: ["sessions", "sessions"],
    }).success).toBe(false)
  })
})

describe("fleetSnapshotSchema", () => {
  it("rejects two machines sharing an identifier", () => {
    expect(fleetSnapshotSchema.safeParse({ entries: [described(machine), described(machine)] }).success).toBe(false)
  })

  it("rejects more than one machine claiming to be this daemon", () => {
    expect(fleetSnapshotSchema.safeParse({
      entries: [described(machine), described({ ...machine, id: `machine-${"b".repeat(32)}` })],
    }).success).toBe(false)
  })

  it("accepts one local machine beside remote machines", () => {
    const remote = {
      ...machine,
      id: `machine-${"b".repeat(32)}`,
      self: false,
      connection: "tailnet" as const,
    }
    expect(fleetSnapshotSchema.parse({ entries: [described(machine), described(remote)] }).entries).toHaveLength(2)
  })

  it("keeps unfinished operations and orphan credentials visible without fabricated facts", () => {
    const entries = [
      described(machine),
      {
        kind: "pending",
        id: "12345678-1234-4234-8234-123456789abc",
        machineId: `machine-${"b".repeat(32)}`,
        operation: "forget",
        startedAt: "2026-09-04T12:00:00.000Z",
      },
      { kind: "unenrolled", machineId: `machine-${"c".repeat(32)}` },
    ]
    expect(fleetSnapshotSchema.parse({ entries }).entries).toEqual(entries)
  })

  it("refuses two lifecycle variants for the same machine", () => {
    expect(fleetSnapshotSchema.safeParse({ entries: [
      described(machine),
      { kind: "unenrolled", machineId: machine.id },
    ] }).success).toBe(false)
  })

  it("bounds the registry", () => {
    const machines = Array.from({ length: maximumFleetMachines + 1 }, (_unused, index) => ({
      ...machine,
      id: `machine-${index.toString(16).padStart(32, "0")}`,
      self: false,
    }))
    expect(fleetSnapshotSchema.safeParse({ entries: machines.map(described) }).success).toBe(false)
  })

  it("keeps recovery rows visible beyond the admission cap but bounds the full wire list", () => {
    const machines = Array.from({ length: maximumFleetMachines }, (_unused, index) => described({
      ...machine, id: `machine-${index.toString(16).padStart(32, "0")}`, self: false,
    }))
    const recovery = Array.from({ length: 512 - maximumFleetMachines }, (_unused, index) => ({
      kind: "unenrolled", machineId: `machine-${(index + maximumFleetMachines).toString(16).padStart(32, "0")}`,
    }))
    expect(fleetSnapshotSchema.parse({ entries: [...machines, ...recovery] }).entries).toHaveLength(512)
    expect(fleetSnapshotSchema.safeParse({ entries: [...machines, ...recovery, {
      kind: "unenrolled", machineId: `machine-${"f".repeat(32)}`,
    }] }).success).toBe(false)
    for (const operation of ["forget", "enroll"] as const) {
      expect(fleetSnapshotSchema.safeParse({ entries: [...machines, ...recovery.slice(0, -1), {
        kind: "pending", id: "12345678-1234-4234-8234-123456789abc", machineId: `machine-${"f".repeat(32)}`,
        operation, startedAt: "2026-09-04T12:00:00.000Z",
      }] }).success).toBe(true)
    }
  })

  it("reports the full omitted count when refusing an over-cap fleet", () => {
    const overflow = { kind: "fleet-overflow", limit: 512, totalEntries: 513, entriesNotShown: 513 }
    expect(fleetSnapshotOverflowSchema.parse(overflow)).toEqual(overflow)
    expect(fleetSnapshotOverflowSchema.safeParse({ ...overflow, entriesNotShown: 514 }).success).toBe(false)
    expect(fleetSnapshotOverflowSchema.safeParse({ ...overflow, totalEntries: 512 }).success).toBe(false)
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

describe("fleet machine WSL facts", () => {
  const { connection: _connection, heartbeat: _heartbeat, health: _health, self: _self, ...descriptor } = machine
  const wsl = { distribution: "Ubuntu-24.04", version: 2 as const }

  it("carries the distribution a daemon runs in under WSL", () => {
    expect(fleetMachineDescriptorSchema.parse({ ...descriptor, wsl })).toEqual({ ...descriptor, wsl })
  })

  it("leaves a machine outside WSL undescribed rather than guessing", () => {
    expect(fleetMachineDescriptorSchema.parse(descriptor)).not.toHaveProperty("wsl")
  })

  it("accepts a WSL 1 distribution", () => {
    expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, wsl: { ...wsl, version: 1 } }).success).toBe(true)
  })

  it("refuses a WSL version that does not exist", () => {
    for (const version of [0, 3, "2", 2.5]) {
      expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, wsl: { ...wsl, version } }).success).toBe(false)
    }
  })

  it("refuses a WSL fact that names no distribution", () => {
    for (const distribution of ["", "   ", undefined]) {
      expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, wsl: { ...wsl, distribution } }).success).toBe(false)
    }
  })

  it("bounds the distribution name like a label", () => {
    expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, wsl: { ...wsl, distribution: "u".repeat(129) } }).success).toBe(false)
  })

  it("rejects unknown WSL fields so facts stay described", () => {
    expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, wsl: { ...wsl, share: "\\\\wsl$" } }).success).toBe(false)
  })

  it("keeps the facts through observed facts and the described machine", () => {
    expect(fleetMachineFactsSchema.parse({ ...descriptor, connection: "local", wsl })).toMatchObject({ wsl })
    expect(fleetMachineSchema.parse({ ...machine, wsl })).toMatchObject({ wsl })
  })
})

describe("machinePlatformLabel", () => {
  it("names the distribution for a daemon under WSL", () => {
    expect(machinePlatformLabel({ platform: "linux", wsl: { distribution: "Ubuntu-24.04", version: 2 } })).toBe("Ubuntu-24.04 (WSL)")
  })

  it("names the platform everywhere else", () => {
    expect(machinePlatformLabel({ platform: "darwin" })).toBe("darwin")
    expect(machinePlatformLabel({ platform: "linux", wsl: undefined })).toBe("linux")
  })
})
