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
  it("uses the same health and heartbeat facts for single-machine lookups and display", () => {
    const { registry: fleet, database } = registry()
    try {
      fleet.record({ ...localMachine, capabilities: [...localMachine.capabilities] }, 1_000)
      for (const now of [1_000, 1_000 + staleHeartbeatMs + 1, 1_000 + offlineHeartbeatMs + 1]) {
        expect(fleet.lookupMachine(localMachine.id, localMachine.id, now))
          .toEqual(machines(fleet.snapshot(localMachine.id, now))[0])
      }
      expect(fleet.lookupMachine(`machine-${"c".repeat(32)}`, localMachine.id, 1_000)).toBeUndefined()
    } finally { database.close() }
  })

  it.each(["enroll", "forget"] as const)("masks retained facts during a pending %s in single-machine lookups", (kind) => {
    const { registry: fleet, database } = registry()
    try {
      const facts = { ...localMachine, capabilities: [...localMachine.capabilities] }
      fleet.record(facts, 1_000)
      if (kind === "forget") fleet.stageForget(localMachine.id, null, 1_000)
      else fleet.stageEnrollment({ ...facts, connection: "direct", verifiedRoute: {
        endpoint: "ws://127.0.0.1:47831/rpc", lastAuthenticatedAt: new Date(1_000).toISOString(),
      } }, "sha256:" + "a".repeat(64), 1_000)
      expect(fleet.lookupMachine(localMachine.id, localMachine.id, 1_000)).toBeUndefined()
      expect(fleet.snapshot(localMachine.id, 1_000).entries[0]?.kind).toBe("pending")
    } finally { database.close() }
  })

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

  it("can expose and forget an orphan even when all machine slots are full", () => {
    const { registry: fleet, database } = registry()
    try {
      for (let index = 0; index < maximumFleetMachines; index += 1) {
        fleet.record({ ...localMachine, id: `machine-${index.toString(16).padStart(32, "0")}`, capabilities: ["sessions"] }, 1_000)
      }
      const orphan = `machine-${"f".repeat(32)}`
      expect(fleet.snapshot(localMachine.id, 1_000, [orphan]).entries).toContainEqual({ kind: "unenrolled", machineId: orphan })
      const operation = fleet.stageForget(orphan, null, 1_000)
      expect(fleet.snapshot(localMachine.id, 1_000, [orphan]).entries).toHaveLength(maximumFleetMachines + 1)
      expect(fleet.completeForget(operation.id)).toBe(true)
      expect(fleet.snapshot(localMachine.id, 1_000).entries).toHaveLength(maximumFleetMachines)
    } finally { database.close() }
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

describe("SqliteFleetRegistry WSL facts", () => {
  const wsl = { distribution: "Ubuntu-24.04", version: 2 as const }
  const facts = () => ({ ...localMachine, capabilities: [...localMachine.capabilities] })

  it("keeps the WSL facts a machine reports, and drops them when it stops reporting them", () => {
    const { registry: fleet, database } = registry()
    try {
      fleet.record({ ...facts(), wsl }, 1_000)
      expect(machines(fleet.snapshot(localMachine.id, 1_000))[0]).toMatchObject({ wsl })

      fleet.record(facts(), 2_000)
      expect(machines(fleet.snapshot(localMachine.id, 2_000))[0]).not.toHaveProperty("wsl")
    } finally { database.close() }
  })

  it("carries the WSL facts through a journaled enrollment", () => {
    const { registry: fleet, database } = registry()
    try {
      const pending = fleet.stageEnrollment({
        ...facts(), wsl, connection: "direct",
        verifiedRoute: { endpoint: "ws://127.0.0.1:47831/rpc", lastAuthenticatedAt: "2026-09-05T12:00:00.000Z" },
      }, `sha256:${"a".repeat(64)}`, 1_000)
      expect(fleet.completeEnrollment(pending.id, `sha256:${"a".repeat(64)}`)).toBe(true)
      expect(fleet.enrolled().map((entry) => entry.facts.wsl)).toEqual([wsl])
    } finally { database.close() }
  })

  it("adds the WSL column to a registry created before it existed", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE fleet_machines (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        version TEXT NOT NULL,
        connection TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        transports TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL
      );
      INSERT INTO fleet_machines VALUES (
        '${localMachine.id}', 'workshop', 'linux', 'x64', '0.0.1', 'local', '["sessions"]', '${protocolVersion}',
        '[{"kind":"local","endpoint":"ws://127.0.0.1:47831/rpc","authenticated":true}]', 500
      );
    `)
    const fleet = new SqliteFleetRegistry(database)
    try {
      expect(machines(fleet.snapshot(localMachine.id, 1_000))[0]).not.toHaveProperty("wsl")
      fleet.record({ ...facts(), wsl }, 1_000)
      expect(machines(fleet.snapshot(localMachine.id, 1_000))[0]).toMatchObject({ wsl })
    } finally { database.close() }
  })

  it("redacts a distribution name that carries a secret before storing it", () => {
    const { registry: fleet, database } = registry()
    try {
      fleet.record({ ...facts(), wsl: { ...wsl, distribution: "token=sk-live-1234567890abcdefghijklmnop" } }, 1_000)
      const stored = machines(fleet.snapshot(localMachine.id, 1_000))[0]?.wsl?.distribution
      expect(stored).toBeDefined()
      expect(stored).not.toContain("sk-live-1234567890abcdefghijklmnop")
    } finally { database.close() }
  })
})
