import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import {
  maximumFleetMachines,
  offlineHeartbeatMs,
  protocolVersion,
  staleHeartbeatMs,
  type FleetSnapshot,
  type MachineCapability,
} from "@getdomovoi/protocol"

import { FleetLimitReachedError, SqliteFleetRegistry } from "./fleet-registry.js"

const localMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local" as const,
  capabilities: ["sessions", "terminals"] as const,
  protocolVersion,
  transports: [
    { kind: "local" as const, endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true as const },
  ],
}

function registry(database = new DatabaseSync(":memory:")): {
  registry: SqliteFleetRegistry
  database: DatabaseSync
} {
  return { registry: new SqliteFleetRegistry(database), database }
}

function machines(snapshot: FleetSnapshot) {
  return snapshot.entries.flatMap((entry) => entry.kind === "machine" ? [entry.machine] : [])
}

describe("SqliteFleetRegistry", () => {
  it("reports the recording daemon as itself", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    const snapshot = fleet.snapshot(localMachine.id, 1_000)

    expect(machines(snapshot)).toEqual([{
      ...localMachine,
      transports: [...localMachine.transports],
      capabilities: [...localMachine.capabilities],
      heartbeat: { state: "online", lastSeenAt: new Date(1_000).toISOString() },
      health: "healthy",
      self: true,
    }])
  })

  it("marks every other machine as not this daemon", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)
    fleet.record({
      ...localMachine,
      id: `machine-${"b".repeat(32)}`,
      label: "studio",
      connection: "tailnet",
      capabilities: ["sessions"],
    }, 1_000)

    const snapshot = fleet.snapshot(localMachine.id, 1_000)

    expect(machines(snapshot).map((machine) => machine.self)).toEqual([true, false])
  })

  it("ages a machine through stale and offline as contact stops", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    expect(machines(fleet.snapshot(localMachine.id, 1_000 + staleHeartbeatMs + 1))[0]?.heartbeat.state)
      .toBe("stale")
    expect(machines(fleet.snapshot(localMachine.id, 1_000 + offlineHeartbeatMs + 1))[0]?.heartbeat.state)
      .toBe("offline")
  })

  it("refreshes contact and facts when a machine reports again", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    fleet.record({
      ...localMachine,
      label: "workshop-renamed",
      version: "0.0.2",
      capabilities: ["sessions"],
    }, 90_000)

    const machine = machines(fleet.snapshot(localMachine.id, 90_000))[0]
    expect(machine).toMatchObject({
      label: "workshop-renamed",
      version: "0.0.2",
      capabilities: ["sessions"],
      heartbeat: { state: "online", lastSeenAt: new Date(90_000).toISOString() },
    })
    expect(machines(fleet.snapshot(localMachine.id, 90_000))).toHaveLength(1)
  })

  it("keeps recorded machines across daemon restarts", () => {
    const database = new DatabaseSync(":memory:")
    new SqliteFleetRegistry(database).record(
      { ...localMachine, capabilities: [...localMachine.capabilities] },
      1_000,
    )

    const restarted = new SqliteFleetRegistry(database)

    expect(machines(restarted.snapshot(localMachine.id, 1_000))).toHaveLength(1)
  })

  it("bounds the registry", () => {
    const { registry: fleet } = registry()
    for (let index = 0; index < maximumFleetMachines; index += 1) {
      fleet.record({
        ...localMachine,
        id: `machine-${index.toString(16).padStart(32, "0")}`,
        capabilities: ["sessions"],
      }, 1_000)
    }

    expect(() => fleet.record({
      ...localMachine,
      id: `machine-${"f".repeat(32)}`,
      capabilities: ["sessions"],
    }, 1_000)).toThrow(FleetLimitReachedError)
  })

  it("rejects a machine whose facts are not describable", () => {
    const { registry: fleet } = registry()

    expect(() => fleet.record({
      ...localMachine,
      id: "laptop",
      capabilities: [...localMachine.capabilities],
    }, 1_000)).toThrow()
    expect(() => fleet.record({
      ...localMachine,
      capabilities: ["mine-bitcoin"] as unknown as MachineCapability[],
    }, 1_000)).toThrow()
  })

  it("reports a machine that stopped answering as unreachable", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    const aged = machines(fleet.snapshot(localMachine.id, 1_000 + offlineHeartbeatMs + 1))[0]

    expect(aged?.health).toBe("unreachable")
  })

  it("reports a machine on an older protocol as needing an upgrade", () => {
    const { registry: fleet } = registry()
    fleet.record({
      ...localMachine,
      capabilities: [...localMachine.capabilities],
      protocolVersion: "0.0.1",
    }, 1_000)

    expect(machines(fleet.snapshot(localMachine.id, 1_000))[0]?.health).toBe("upgrade-required")
  })

  it("reports a machine on a newer protocol as a version mismatch", () => {
    const { registry: fleet } = registry()
    fleet.record({
      ...localMachine,
      capabilities: [...localMachine.capabilities],
      protocolVersion: "9.0.0",
    }, 1_000)

    expect(machines(fleet.snapshot(localMachine.id, 1_000))[0]?.health).toBe("version-mismatch")
  })

  it("returns a snapshot the protocol accepts", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)
    fleet.record({
      ...localMachine,
      id: `machine-${"b".repeat(32)}`,
      connection: "ssh",
      capabilities: ["sessions"],
    }, 1_000)

    expect(() => fleet.snapshot(localMachine.id, 1_000)).not.toThrow()
  })
})
