import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import {
  fleetMachineFactsSchema,
  fleetMachineSchema,
  fleetHealthSchema,
  fleetMachineHealth,
  fleetSnapshotSchema,
  machineHeartbeatState,
  maximumFleetMachines,
  maximumFleetEntries,
  fleetSnapshotOverflowSchema,
  machineIdSchema,
  protocolVersion,
  sha256DigestSchema,
  type FleetEntry,
  type FleetMachineFacts,
  type FleetMachine,
  type FleetSnapshot,
} from "@getdomovoi/protocol"

import {
  fleetEnrollmentOperationSchema,
  fleetForgetOperationSchema,
  fleetOperationSchema,
  fleetOperationSummary,
  type FleetEnrollmentOperation,
  type FleetForgetOperation,
  type FleetOperation,
} from "./fleet-operations.js"
import { redactDurableText } from "./secret-redaction.js"

const fleetConnectionFailureSchema = fleetHealthSchema.exclude(["healthy", "degraded"])
export type FleetConnectionFailure = typeof fleetConnectionFailureSchema._output
export type EnrolledFleetMachine = { facts: FleetMachineFacts; credentialDigest: string }

export class FleetLimitReachedError extends Error {
  constructor() {
    super(`Fleet machine limit of ${maximumFleetMachines} reached`)
    this.name = "FleetLimitReachedError"
  }
}

export class FleetOperationInProgressError extends Error {
  constructor() {
    super("That machine already has an unfinished fleet operation")
    this.name = "FleetOperationInProgressError"
  }
}

export class FleetSnapshotOverflowError extends Error {
  readonly overflow
  constructor(totalEntries: number) {
    super(`Fleet contains ${totalEntries} entries, above the ${maximumFleetEntries}-entry display limit. No entries were shown. Run domovoid fleet-keychain list and remove unused local credentials by machine id.`)
    this.name = "FleetSnapshotOverflowError"
    this.overflow = fleetSnapshotOverflowSchema.parse({
      kind: "fleet-overflow", limit: maximumFleetEntries, totalEntries, entriesNotShown: totalEntries,
    })
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
  verified_route: string | null
  credential_digest: string | null
  health_override: string | null
  wsl: string | null
}

export interface FleetRegistry {
  record(facts: FleetMachineFacts, nowMs: number): void
  snapshot(selfId: string, nowMs: number, credentialMachineIds?: readonly string[]): FleetSnapshot
  lookupMachine(machineId: string, selfId: string, nowMs: number): FleetMachine | undefined
  enrolled(): EnrolledFleetMachine[]
  pendingOperations(): FleetOperation[]
  stageEnrollment(facts: FleetMachineFacts, credentialDigest: string, nowMs: number): FleetEnrollmentOperation
  completeEnrollment(operationId: string, credentialDigest: string): boolean
  abortEnrollment(operationId: string): boolean
  stageForget(machineId: string, credentialDigest: string | null, nowMs: number): FleetForgetOperation
  pendingForgetEnrollment(operationId: string): EnrolledFleetMachine | undefined
  confirmRemoteRevocation(operationId: string): boolean
  completeForget(operationId: string): boolean
  refreshAuthenticated(facts: FleetMachineFacts, credentialDigest: string, nowMs: number): boolean
  recordFailure(machineId: string, credentialDigest: string, failure: FleetConnectionFailure): boolean
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
      CREATE TABLE IF NOT EXISTS fleet_operations (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
    `)
    const columns = this.#database.prepare("PRAGMA table_info(fleet_machines)").all() as Array<{ name: string }>
    for (const name of ["verified_route", "credential_digest", "health_override", "wsl"]) {
      if (!columns.some((column) => column.name === name)) {
        this.#database.exec(`ALTER TABLE fleet_machines ADD COLUMN ${name} TEXT`)
      }
    }
  }

  record(facts: FleetMachineFacts, nowMs: number): void {
    // Parsing here keeps undescribable facts out of durable state instead of
    // failing later when a client reads the fleet.
    const machine = durableFacts(facts)
    this.#transaction(() => {
      this.#requireSpace(machine.id)
      this.#writeMachine(machine, nowMs, null)
    })
  }

  #writeMachine(machine: FleetMachineFacts, nowMs: number, credentialDigest: string | null): void {

    this.#database
      .prepare(`
        INSERT INTO fleet_machines (
          id, label, platform, arch, version, connection, capabilities, protocol_version,
          transports, last_seen_ms, verified_route, credential_digest, health_override, wsl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          platform = excluded.platform,
          arch = excluded.arch,
          version = excluded.version,
          connection = excluded.connection,
          capabilities = excluded.capabilities,
          protocol_version = excluded.protocol_version,
          transports = excluded.transports,
          last_seen_ms = excluded.last_seen_ms,
          verified_route = excluded.verified_route,
          credential_digest = excluded.credential_digest,
          health_override = NULL,
          wsl = excluded.wsl
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
        machine.verifiedRoute === undefined ? null : JSON.stringify(machine.verifiedRoute),
        credentialDigest,
        machine.wsl === undefined ? null : JSON.stringify(machine.wsl),
      )
  }

  snapshot(selfId: string, nowMs: number, credentialMachineIds: readonly string[] = []): FleetSnapshot {
    const rows = this.#database
      .prepare("SELECT * FROM fleet_machines ORDER BY id ASC")
      .all() as StoredFleetMachine[]
    const entries = new Map<string, FleetEntry>()
    for (const row of rows) {
      entries.set(row.id, { kind: "machine", machine: readMachine(row, selfId, nowMs) })
    }
    for (const pending of this.pendingOperations()) {
      entries.set(pending.machineId, fleetOperationSummary(pending))
    }
    for (const id of credentialMachineIds) {
      machineIdSchema.parse(id)
      if (!entries.has(id)) entries.set(id, { kind: "unenrolled", machineId: id })
    }
    if (entries.size > maximumFleetEntries) throw new FleetSnapshotOverflowError(entries.size)
    // Stable machine keys keep pending/unenrolled states in place rather than
    // moving a row every time a heartbeat refreshes its timestamp.
    return fleetSnapshotSchema.parse({ entries: [...entries]
      .sort(([left], [right]) => left === selfId ? -1 : right === selfId ? 1 : left.localeCompare(right))
      .map(([, entry]) => entry) })
  }

  lookupMachine(machineId: string, selfId: string, nowMs: number): FleetMachine | undefined {
    // Display limits do not limit access to a known peer. The same journal
    // masking still applies: retained facts must never revive a forgetting peer.
    const row = this.#database.prepare(`
      SELECT * FROM fleet_machines m WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM fleet_operations o WHERE o.machine_id = m.id)
    `).get(machineId) as StoredFleetMachine | undefined
    return row ? readMachine(row, selfId, nowMs) : undefined
  }

  enrolled(): EnrolledFleetMachine[] {
    const rows = this.#database.prepare(`
      SELECT * FROM fleet_machines m WHERE credential_digest IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM fleet_operations o WHERE o.machine_id = m.id)
      ORDER BY id ASC
    `).all() as StoredFleetMachine[]
    return rows.map((row) => ({ facts: readFacts(row), credentialDigest: sha256DigestSchema.parse(row.credential_digest) }))
  }

  pendingOperations(): FleetOperation[] {
    const rows = this.#database.prepare("SELECT payload FROM fleet_operations ORDER BY machine_id ASC")
      .all() as Array<{ payload: string }>
    return rows.map((row) => fleetOperationSchema.parse(JSON.parse(row.payload)))
  }

  stageEnrollment(facts: FleetMachineFacts, credentialDigest: string, nowMs: number): FleetEnrollmentOperation {
    const pending = fleetEnrollmentOperationSchema.parse({
      version: 1, id: randomUUID(), machineId: facts.id, kind: "enroll",
      startedAt: new Date(nowMs).toISOString(), credentialDigest, facts: durableFacts(facts),
    })
    this.#stage(pending)
    return pending
  }

  stageForget(machineId: string, credentialDigest: string | null, nowMs: number): FleetForgetOperation {
    const pending = fleetForgetOperationSchema.parse({
      version: 1, id: randomUUID(), machineId, kind: "forget",
      startedAt: new Date(nowMs).toISOString(), credentialDigest, remoteRevocation: "unconfirmed",
    })
    this.#stage(pending)
    return pending
  }

  #stage(pending: FleetOperation): void {
    this.#transaction(() => {
      if (this.#database.prepare("SELECT 1 FROM fleet_operations WHERE machine_id = ?").get(pending.machineId)) {
        throw new FleetOperationInProgressError()
      }
      // Forget releases authority; recovery must work even at capacity.
      if (pending.kind === "enroll") this.#requireSpace(pending.machineId)
      this.#database.prepare("INSERT INTO fleet_operations (id, machine_id, payload) VALUES (?, ?, ?)")
        .run(pending.id, pending.machineId, JSON.stringify(pending))
    })
  }

  completeEnrollment(operationId: string, credentialDigest: string): boolean {
    return this.#transaction(() => {
      const pending = this.#operation(operationId)
      if (pending?.kind !== "enroll" || pending.credentialDigest !== credentialDigest) return false
      // The caller checked keychain readback. Promotion and journal removal
      // are one SQLite transaction, never a published row with a live journal.
      // Staging and recovery are not contact with the target. Keep the source's
      // original authenticated-receipt time even when promotion runs much later.
      this.#writeMachine(pending.facts, Date.parse(pending.facts.verifiedRoute.lastAuthenticatedAt), pending.credentialDigest)
      this.#deleteOperation(operationId)
      return true
    })
  }

  abortEnrollment(operationId: string): boolean {
    return this.#transaction(() => {
      const pending = this.#operation(operationId)
      if (pending?.kind !== "enroll") return false
      // Claiming the new code may already have retired the previous key. Keep
      // its historical facts, but never present the old enrollment as healthy.
      this.#database.prepare("UPDATE fleet_machines SET health_override = 'pairing-required' WHERE id = ?")
        .run(pending.machineId)
      this.#deleteOperation(operationId)
      return true
    })
  }

  confirmRemoteRevocation(operationId: string): boolean {
    return this.#transaction(() => {
      const pending = this.#operation(operationId)
      if (pending?.kind !== "forget") return false
      this.#database.prepare("UPDATE fleet_operations SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ ...pending, remoteRevocation: "confirmed" }), operationId)
      return true
    })
  }

  pendingForgetEnrollment(operationId: string): EnrolledFleetMachine | undefined {
    const operation = this.#operation(operationId)
    if (operation?.kind !== "forget" || operation.credentialDigest === null) return undefined
    // This route is available only to finish this journaled revocation, never
    // to ordinary dialing or heartbeat while forget is in progress.
    const row = this.#database.prepare("SELECT * FROM fleet_machines WHERE id = ? AND credential_digest = ?")
      .get(operation.machineId, operation.credentialDigest) as StoredFleetMachine | undefined
    return row === undefined ? undefined : { facts: readFacts(row), credentialDigest: operation.credentialDigest }
  }

  completeForget(operationId: string): boolean {
    return this.#transaction(() => {
      const pending = this.#operation(operationId)
      if (pending?.kind !== "forget") return false
      this.#database.prepare("DELETE FROM fleet_machines WHERE id = ?").run(pending.machineId)
      this.#deleteOperation(operationId)
      return true
    })
  }

  refreshAuthenticated(facts: FleetMachineFacts, credentialDigest: string, nowMs: number): boolean {
    const machine = durableFacts(facts)
    return this.#transaction(() => {
      const current = this.#database.prepare(`
        SELECT 1 FROM fleet_machines WHERE id = ? AND credential_digest = ?
        AND NOT EXISTS (SELECT 1 FROM fleet_operations WHERE machine_id = ?)
      `).get(machine.id, credentialDigest, machine.id)
      if (!current) return false
      // Check and write share a database write lock, with no await between
      // them. A late response cannot resurrect a forgotten/replaced enrollment.
      this.#writeMachine(machine, nowMs, credentialDigest)
      return true
    })
  }

  recordFailure(machineId: string, credentialDigest: string, failure: FleetConnectionFailure): boolean {
    const health = fleetConnectionFailureSchema.parse(failure)
    const result = this.#database.prepare(`
      UPDATE fleet_machines SET health_override = ? WHERE id = ? AND credential_digest = ?
      AND NOT EXISTS (SELECT 1 FROM fleet_operations WHERE machine_id = ?)
    `).run(health, machineId, credentialDigest, machineId)
    return Number(result.changes) > 0
  }

  #operation(id: string): FleetOperation | undefined {
    const row = this.#database.prepare("SELECT payload FROM fleet_operations WHERE id = ?").get(id) as { payload: string } | undefined
    return row === undefined ? undefined : fleetOperationSchema.parse(JSON.parse(row.payload))
  }

  #deleteOperation(id: string): void {
    this.#database.prepare("DELETE FROM fleet_operations WHERE id = ?").run(id)
  }

  #requireSpace(id: string): void {
    const operations = this.pendingOperations()
    const forgetting = new Set(operations.filter((entry) => entry.kind === "forget").map((entry) => entry.machineId))
    const rows = this.#database.prepare("SELECT id FROM fleet_machines").all() as Array<{ id: string }>
    const admitted = new Set(rows.filter((row) => !forgetting.has(row.id)).map((row) => row.id))
    for (const entry of operations) if (entry.kind === "enroll") admitted.add(entry.machineId)
    if (!admitted.has(id) && admitted.size >= maximumFleetMachines) throw new FleetLimitReachedError()
  }

  #transaction<T>(run: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const result = run()
      this.#database.exec("COMMIT")
      return result
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }
}

function readMachine(row: StoredFleetMachine, selfId: string, nowMs: number): FleetMachine {
  const heartbeat = machineHeartbeatState(row.last_seen_ms, nowMs)
  return fleetMachineSchema.parse({
    ...readFacts(row),
    heartbeat: { state: heartbeat, lastSeenAt: new Date(row.last_seen_ms).toISOString() },
    health: row.health_override === null ? fleetMachineHealth({
      heartbeat,
      connection: heartbeat === "offline" ? "disconnected" : "connected",
      protocolVersion: row.protocol_version,
      clientProtocolVersion: protocolVersion,
    }) : fleetConnectionFailureSchema.parse(row.health_override),
    self: row.id === selfId,
  })
}

function readFacts(row: StoredFleetMachine): FleetMachineFacts {
  return fleetMachineFactsSchema.parse({
    id: row.id, label: row.label, platform: row.platform, arch: row.arch, version: row.version,
    connection: row.connection, capabilities: JSON.parse(row.capabilities), protocolVersion: row.protocol_version,
    transports: JSON.parse(row.transports),
    ...(row.verified_route === null ? {} : { verifiedRoute: JSON.parse(row.verified_route) }),
    ...(row.wsl === null ? {} : { wsl: JSON.parse(row.wsl) }),
  })
}

function durableFacts(facts: FleetMachineFacts): FleetMachineFacts {
  const parsed = fleetMachineFactsSchema.parse(facts)
  for (const endpoint of [...parsed.transports.map((entry) => entry.endpoint), parsed.verifiedRoute?.endpoint]) {
    if (endpoint !== undefined && redactDurableText(endpoint).redacted) {
      throw new Error("Fleet endpoints cannot contain secrets")
    }
  }
  return fleetMachineFactsSchema.parse({
    ...parsed,
    label: redactDurableText(parsed.label).value.slice(0, 128),
    platform: redactDurableText(parsed.platform).value.slice(0, 64),
    arch: redactDurableText(parsed.arch).value.slice(0, 64),
    version: redactDurableText(parsed.version).value.slice(0, 64),
    ...(parsed.wsl === undefined ? {} : {
      wsl: { ...parsed.wsl, distribution: redactDurableText(parsed.wsl.distribution).value.slice(0, 128) },
    }),
  })
}
