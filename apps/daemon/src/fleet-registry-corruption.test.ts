import { DatabaseSync } from "node:sqlite"

import { maximumFleetEntries, protocolVersion, type FleetMachineFacts } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import { FleetSnapshotOverflowError, SqliteFleetRegistry } from "./fleet-registry.js"

const selfId = `machine-${"a".repeat(32)}`
const corruptId = `machine-${"b".repeat(32)}`
const healthyId = `machine-${"c".repeat(32)}`
const credentialDigest = `sha256:${"d".repeat(64)}`
const receivedAt = Date.parse("2026-09-05T12:00:00.000Z")

function facts(id: string): FleetMachineFacts {
  return {
    id, label: "studio", platform: "linux", arch: "x64", version: "0.0.1",
    connection: "direct", capabilities: ["sessions"], protocolVersion,
    transports: [], verifiedRoute: {
      endpoint: "ws://127.0.0.1:47831/rpc", lastAuthenticatedAt: new Date(receivedAt).toISOString(),
    },
  }
}

function fixture() {
  const database = new DatabaseSync(":memory:")
  const registry = new SqliteFleetRegistry(database)
  for (const id of [corruptId, healthyId]) {
    const operation = registry.stageEnrollment(facts(id), credentialDigest, receivedAt)
    registry.completeEnrollment(operation.id, credentialDigest)
  }
  return { database, registry }
}

for (const corruption of ["{malformed-json", '["invalid-capability"]']) {
  for (const reader of ["snapshot", "enrolled", "lookupMachine"] as const) {
    it(`${reader} isolates ${corruption.startsWith("{") ? "malformed JSON" : "invalid facts"} to the damaged machine`, () => {
      const database = new DatabaseSync(":memory:")
      const registry = new SqliteFleetRegistry(database)
      try {
        for (const id of [corruptId, healthyId]) {
          const operation = registry.stageEnrollment(facts(id), credentialDigest, receivedAt)
          expect(registry.completeEnrollment(operation.id, credentialDigest)).toBe(true)
        }
        database.prepare("UPDATE fleet_machines SET capabilities = ? WHERE id = ?").run(corruption, corruptId)
        switch (reader) {
          case "snapshot":
            expect(registry.snapshot(selfId, receivedAt).entries.flatMap((entry) => entry.kind === "machine" ? [entry.machine.id] : []))
              .toEqual([healthyId])
            break
          case "enrolled":
            expect(registry.enrolled().map((entry) => entry.facts.id)).toEqual([healthyId])
            break
          case "lookupMachine":
            expect(registry.lookupMachine(corruptId, selfId, receivedAt)).toBeUndefined()
            expect(registry.lookupMachine(healthyId, selfId, receivedAt)?.id).toBe(healthyId)
            break
        }
      } finally { database.close() }
    })
  }
}

it("retains damaged bytes once, audits only classification, and survives a registry restart", () => {
  const { database, registry } = fixture()
  const secret = "sk-test-sensitive-damaged-fleet-row"
  try {
    database.prepare("UPDATE fleet_machines SET capabilities = ?, label = ? WHERE id = ?")
      .run(`{${secret}`, secret, corruptId)
    const first = registry.snapshot(selfId, receivedAt, [corruptId])
    expect(first.entries.map((entry) => entry.kind)).toEqual(["machine"])
    expect(first.registry).toMatchObject({ state: "degraded", quarantined: [{
      kind: "quarantined", machineId: corruptId, reason: "invalid-json", recoveryAction: "forget-and-enroll",
    }] })
    expect(new SqliteFleetRegistry(database).snapshot(selfId, receivedAt, [corruptId])).toEqual(first)
    expect(database.prepare("SELECT capabilities FROM fleet_machines WHERE id = ?").get(corruptId))
      .toMatchObject({ capabilities: `{${secret}` })
    const receipts = database.prepare("SELECT * FROM audit_log WHERE action = 'fleet.quarantine'").all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ actor_kind: "daemon", actor_name: "fleet-registry", target: first.registry?.quarantined[0]?.id })
    expect(JSON.stringify({ first, receipts })).not.toContain(secret)
  } finally { database.close() }
})

it.each([
  ["transports", "{"], ["verified_route", "{"], ["wsl", "{"],
  ["credential_digest", "not-a-digest"], ["last_seen_ms", "not-a-time"],
  ["health_override", "invented-health"], ["protocol_version", "invalid-version"],
  ["capabilities", '"sessions"'], ["transports", "{}"], ["label", ""],
] as const)("validates %s before any reader offers an enrollment", (column, value) => {
  const { database, registry } = fixture()
  try {
    database.prepare(`UPDATE fleet_machines SET ${column} = ? WHERE id = ?`).run(value, corruptId)
    expect(registry.enrolled().map((entry) => entry.facts.id)).toEqual([healthyId])
    expect(registry.lookupMachine(corruptId, selfId, receivedAt)).toBeUndefined()
    expect(registry.snapshot(selfId, receivedAt).registry?.quarantined).toHaveLength(1)
  } finally { database.close() }
})

it("never publishes a malformed durable identity as an unenrolled machine", () => {
  const { database, registry } = fixture()
  try {
    database.prepare("UPDATE fleet_machines SET id = 'damaged-secret-id' WHERE id = ?").run(corruptId)
    const snapshot = registry.snapshot(selfId, receivedAt)
    expect(snapshot.registry?.quarantined[0]).toMatchObject({ recoveryAction: "repair-registry-offline" })
    expect(snapshot.registry?.quarantined[0]).not.toHaveProperty("machineId")
    expect(JSON.stringify(snapshot)).not.toContain("damaged-secret-id")
  } finally { database.close() }
})

it("rolls quarantine back when its audit receipt cannot persist", () => {
  const { database, registry } = fixture()
  try {
    database.prepare("UPDATE fleet_machines SET capabilities = '{' WHERE id = ?").run(corruptId)
    database.exec("CREATE TRIGGER reject_quarantine_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    expect(() => registry.snapshot(selfId, receivedAt)).toThrow("audit unavailable")
    expect(database.prepare("SELECT * FROM audit_log").all()).toHaveLength(0)
    database.exec("DROP TRIGGER reject_quarantine_audit")
    expect(registry.snapshot(selfId, receivedAt).registry?.quarantined).toHaveLength(1)
    expect(database.prepare("SELECT * FROM audit_log").all()).toHaveLength(1)
  } finally { database.close() }
})

it("keeps a forgetting peer masked and cannot dial damaged revocation facts", () => {
  const { database, registry } = fixture()
  try {
    const forget = registry.stageForget(corruptId, credentialDigest, receivedAt)
    database.prepare("UPDATE fleet_machines SET capabilities = '{' WHERE id = ?").run(corruptId)
    expect(registry.pendingForgetEnrollment(forget.id)).toBeUndefined()
    expect(registry.lookupMachine(corruptId, selfId, receivedAt)).toBeUndefined()
    expect(registry.snapshot(selfId, receivedAt, [corruptId]).entries[0]?.kind).toBe("pending")
    expect(registry.snapshot(selfId, receivedAt).registry).toBeUndefined()
    expect(registry.completeForget(forget.id)).toBe(true)
    expect(registry.snapshot(selfId, receivedAt).registry).toBeUndefined()
    expect(database.prepare("SELECT * FROM fleet_machines WHERE id = ?").get(corruptId)).toBeUndefined()
  } finally { database.close() }
})

it("does not let a late heartbeat resurrect quarantine but allows explicit re-enrollment", () => {
  const { database, registry } = fixture()
  try {
    database.prepare("UPDATE fleet_machines SET capabilities = '{' WHERE id = ?").run(corruptId)
    registry.snapshot(selfId, receivedAt)
    expect(registry.refreshAuthenticated(facts(corruptId), credentialDigest, receivedAt + 1)).toBe(false)
    expect(registry.recordFailure(corruptId, credentialDigest, "reconnecting")).toBe(false)
    const enrollment = registry.stageEnrollment(facts(corruptId), credentialDigest, receivedAt)
    expect(registry.completeEnrollment(enrollment.id, credentialDigest)).toBe(true)
    expect(registry.snapshot(selfId, receivedAt).registry).toBeUndefined()
    expect(registry.lookupMachine(corruptId, selfId, receivedAt)?.id).toBe(corruptId)
  } finally { database.close() }
})

it.each([
  ["quarantine_id", null], ["quarantine_id", "invalid-secret-id"],
  ["quarantined_at", "not-a-time"], ["quarantine_reason", "secret-error"],
] as const)("repairs damaged quarantine metadata in %s without losing the original row", (column, value) => {
  const { database, registry } = fixture()
  try {
    database.prepare("UPDATE fleet_machines SET capabilities = '{' WHERE id = ?").run(corruptId)
    const initial = registry.snapshot(selfId, receivedAt)
    database.prepare(`UPDATE fleet_machines SET ${column} = ? WHERE id = ?`).run(value, corruptId)
    expect(registry.refreshAuthenticated(facts(corruptId), credentialDigest, receivedAt + 1)).toBe(false)
    const repaired = registry.snapshot(selfId, receivedAt)
    expect(repaired.entries).toEqual(initial.entries)
    expect(repaired.registry?.quarantined[0]).toMatchObject({ reason: "invalid-facts", machineId: corruptId })
    expect(repaired.registry?.quarantined[0]?.id).not.toBe(initial.registry?.quarantined[0]?.id)
    expect(registry.snapshot(selfId, receivedAt)).toEqual(repaired)
    expect(database.prepare("SELECT capabilities FROM fleet_machines WHERE id = ?").get(corruptId)).toMatchObject({ capabilities: "{" })
    expect(JSON.stringify(repaired)).not.toContain("secret")
  } finally { database.close() }
})

it("counts quarantined records against the display bound without truncation", () => {
  const { database, registry } = fixture()
  try {
    database.prepare("UPDATE fleet_machines SET capabilities = '{' WHERE id = ?").run(corruptId)
    const orphans = Array.from({ length: maximumFleetEntries - 2 }, (_, index) => `machine-${index.toString(16).padStart(32, "0")}`)
    const snapshot = registry.snapshot(selfId, receivedAt, orphans)
    expect(snapshot.entries.length + (snapshot.registry?.quarantined.length ?? 0)).toBe(maximumFleetEntries)
    expect(() => registry.snapshot(selfId, receivedAt, [...orphans, selfId])).toThrow(FleetSnapshotOverflowError)
  } finally { database.close() }
})

it("does not turn database failures or corrupt operation journals into absent authority", () => {
  const { database, registry } = fixture()
  try {
    registry.stageForget(corruptId, credentialDigest, receivedAt)
    database.exec("UPDATE fleet_operations SET payload = '{'")
    expect(() => registry.snapshot(selfId, receivedAt)).toThrow()
    expect(registry.lookupMachine(corruptId, selfId, receivedAt)).toBeUndefined()
    database.exec("DROP TABLE fleet_machines")
    expect(() => registry.enrolled()).toThrow("no such table")
  } finally { database.close() }
})
