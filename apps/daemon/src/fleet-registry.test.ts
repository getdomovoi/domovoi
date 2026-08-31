import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { maximumFleetMachines, offlineHeartbeatMs, staleHeartbeatMs } from "@getdomovoi/protocol"

import { FleetLimitReachedError, SqliteFleetRegistry } from "./fleet-registry.js"

const localMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local" as const,
  capabilities: ["sessions", "terminals"] as const,
}

function registry(database = new DatabaseSync(":memory:")): {
  registry: SqliteFleetRegistry
  database: DatabaseSync
} {
  return { registry: new SqliteFleetRegistry(database), database }
}

describe("SqliteFleetRegistry", () => {
  it("reports the recording daemon as itself", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    const snapshot = fleet.snapshot(localMachine.id, 1_000)

    expect(snapshot.machines).toEqual([{
      ...localMachine,
      capabilities: [...localMachine.capabilities],
      heartbeat: { state: "online", lastSeenAt: new Date(1_000).toISOString() },
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

    expect(snapshot.machines.map((machine) => machine.self)).toEqual([true, false])
  })

  it("ages a machine through stale and offline as contact stops", () => {
    const { registry: fleet } = registry()
    fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)

    expect(fleet.snapshot(localMachine.id, 1_000 + staleHeartbeatMs + 1).machines[0]?.heartbeat.state)
      .toBe("stale")
    expect(fleet.snapshot(localMachine.id, 1_000 + offlineHeartbeatMs + 1).machines[0]?.heartbeat.state)
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

    const machine = fleet.snapshot(localMachine.id, 90_000).machines[0]
    expect(machine).toMatchObject({
      label: "workshop-renamed",
      version: "0.0.2",
      capabilities: ["sessions"],
      heartbeat: { state: "online", lastSeenAt: new Date(90_000).toISOString() },
    })
    expect(fleet.snapshot(localMachine.id, 90_000).machines).toHaveLength(1)
  })

  it("keeps recorded machines across daemon restarts", () => {
    const database = new DatabaseSync(":memory:")
    new SqliteFleetRegistry(database).record(
      { ...localMachine, capabilities: [...localMachine.capabilities] },
      1_000,
    )

    const restarted = new SqliteFleetRegistry(database)

    expect(restarted.snapshot(localMachine.id, 1_000).machines).toHaveLength(1)
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
      capabilities: ["mine-bitcoin"] as unknown as string[],
    }, 1_000)).toThrow()
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
