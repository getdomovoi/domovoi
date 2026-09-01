import type { DatabaseSync } from "node:sqlite"

import {
  fleetMachineFactsSchema,
  fleetMachineHealth,
  fleetSnapshotSchema,
  machineHeartbeatState,
  maximumFleetMachines,
  protocolVersion,
  type FleetMachineFacts,
  type TransportCandidate,
  type FleetSnapshot,
  type MachineCapability,
} from "@getdomovoi/protocol"

export class FleetLimitReachedError extends Error {
  constructor() {
    super(`Fleet machine limit of ${maximumFleetMachines} reached`)
    this.name = "FleetLimitReachedError"
  }
}

type StoredFleetMachine = {
  id: string
  label: string
  platform: string
  arch: string
  version: string
  connection: string
  capabilities: string
  protocol_version: string
  transports: string
  last_seen_ms: number
}

export interface FleetRegistry {
  record(facts: FleetMachineFacts, nowMs: number): void
  snapshot(selfId: string, nowMs: number): FleetSnapshot
}

export class SqliteFleetRegistry implements FleetRegistry {
  #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS fleet_machines (
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
      CREATE INDEX IF NOT EXISTS fleet_machines_last_seen ON fleet_machines (last_seen_ms DESC);
    `)
  }

  record(facts: FleetMachineFacts, nowMs: number): void {
    // Parsing here keeps undescribable facts out of durable state instead of
    // failing later when a client reads the fleet.
    const machine = fleetMachineFactsSchema.parse(facts)
    const known = this.#database
      .prepare("SELECT 1 FROM fleet_machines WHERE id = ?")
      .get(machine.id) !== undefined
    if (!known) {
      const total = this.#database
        .prepare("SELECT COUNT(*) AS total FROM fleet_machines")
        .get() as { total: number }
      if (total.total >= maximumFleetMachines) throw new FleetLimitReachedError()
    }

    this.#database
      .prepare(`
        INSERT INTO fleet_machines (
          id, label, platform, arch, version, connection, capabilities, protocol_version,
          transports, last_seen_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          platform = excluded.platform,
          arch = excluded.arch,
          version = excluded.version,
          connection = excluded.connection,
          capabilities = excluded.capabilities,
          protocol_version = excluded.protocol_version,
          transports = excluded.transports,
          last_seen_ms = excluded.last_seen_ms
      `)
      .run(
        machine.id,
        machine.label,
        machine.platform,
        machine.arch,
        machine.version,
        machine.connection,
        JSON.stringify(machine.capabilities),
        machine.protocolVersion,
        JSON.stringify(machine.transports),
        nowMs,
      )
  }

  snapshot(selfId: string, nowMs: number): FleetSnapshot {
    const rows = this.#database
      .prepare("SELECT * FROM fleet_machines ORDER BY last_seen_ms DESC, id ASC")
      .all() as StoredFleetMachine[]
    return fleetSnapshotSchema.parse({
      machines: rows.map((row) => {
        const heartbeat = machineHeartbeatState(row.last_seen_ms, nowMs)
        return {
        id: row.id,
        label: row.label,
        platform: row.platform,
        arch: row.arch,
        version: row.version,
        connection: row.connection,
        capabilities: JSON.parse(row.capabilities) as MachineCapability[],
        protocolVersion: row.protocol_version,
        transports: JSON.parse(row.transports) as TransportCandidate[],
        heartbeat: {
          state: heartbeat,
          lastSeenAt: new Date(row.last_seen_ms).toISOString(),
        },
        // The daemon only observes its own link, so a machine it is not
        // currently hearing from counts as disconnected rather than retrying.
        health: fleetMachineHealth({
          heartbeat,
          connection: heartbeat === "offline" ? "disconnected" : "connected",
          protocolVersion: row.protocol_version,
          clientProtocolVersion: protocolVersion,
        }),
        self: row.id === selfId,
      }
      }),
    })
  }
}
