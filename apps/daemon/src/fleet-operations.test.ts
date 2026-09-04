import { DatabaseSync } from "node:sqlite"

import { protocolVersion, type FleetMachineFacts } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { FleetOperationInProgressError, SqliteFleetRegistry } from "./fleet-registry.js"
import { machineCredentialDigest } from "./machine-credentials.js"

const localId = `machine-${"a".repeat(32)}`
const remoteId = `machine-${"b".repeat(32)}`
const token = "n".repeat(43)
const facts: FleetMachineFacts = {
  id: remoteId,
  label: "studio",
  platform: "darwin",
  arch: "arm64",
  version: "0.0.1",
  protocolVersion,
  connection: "direct",
  capabilities: ["sessions"],
  transports: [],
  verifiedRoute: { endpoint: "wss://studio.tailnet/rpc", lastAuthenticatedAt: new Date(1_000).toISOString() },
}
const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })

function fixture() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  return { database, fleet: new SqliteFleetRegistry(database), digest: machineCredentialDigest(remoteId, token) }
}

describe("durable fleet operations", () => {
  it("stages an enrollment without publishing its machine facts or credential digest", () => {
    const { fleet, database, digest } = fixture()
    const staged = fleet.stageEnrollment(facts, digest, 1_000)
    const pending = { kind: "pending", id: staged.id, machineId: remoteId, operation: "enroll", startedAt: new Date(1_000).toISOString() }
    expect(fleet.snapshot(localId, 1_000).entries).toEqual([pending])
    expect(fleet.enrolled()).toEqual([])
    expect(JSON.stringify(fleet.snapshot(localId, 1_000))).not.toContain(digest)
    expect(new SqliteFleetRegistry(database).pendingOperations()).toEqual([staged])
    const stored = JSON.stringify(database.prepare("SELECT * FROM fleet_operations").all())
    expect(stored).toContain(digest)
    expect(stored).not.toContain(token)
  })

  it("promotes only the operation whose staged digest matches the keychain readback", () => {
    const { fleet, digest } = fixture()
    const staged = fleet.stageEnrollment(facts, digest, 1_000)
    expect(fleet.completeEnrollment(staged.id, machineCredentialDigest(remoteId, "z".repeat(43)))).toBe(false)
    expect(fleet.snapshot(localId, 1_000).entries[0]?.kind).toBe("pending")
    expect(fleet.completeEnrollment(staged.id, digest)).toBe(true)
    expect(fleet.pendingOperations()).toEqual([])
    expect(fleet.enrolled()).toEqual([{ facts, credentialDigest: digest }])
    expect(fleet.snapshot(localId, 1_000).entries).toEqual([{ kind: "machine", machine: {
      ...facts, self: false, health: "healthy", heartbeat: { state: "online", lastSeenAt: new Date(1_000).toISOString() },
    } }])
    expect(fleet.completeEnrollment(staged.id, digest)).toBe(false)
  })

  it("never counts staging or restart time as a successful heartbeat", () => {
    const { fleet, database, digest } = fixture()
    const staged = fleet.stageEnrollment(facts, digest, 9_000)
    const restarted = new SqliteFleetRegistry(database)
    restarted.completeEnrollment(staged.id, digest)
    expect(restarted.snapshot(localId, 10_000).entries[0]).toMatchObject({ machine: {
      heartbeat: { lastSeenAt: facts.verifiedRoute!.lastAuthenticatedAt },
    } })
  })

  it("rolls back promotion if removing its journal fails", () => {
    const { fleet, database, digest } = fixture()
    const staged = fleet.stageEnrollment(facts, digest, 1_000)
    database.exec("CREATE TRIGGER fail_promotion BEFORE DELETE ON fleet_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    expect(() => fleet.completeEnrollment(staged.id, digest)).toThrow("injected failure")
    expect(database.prepare("SELECT id FROM fleet_machines").all()).toEqual([])
    expect(fleet.pendingOperations()).toEqual([staged])
  })

  it("redacts reported text before journaling, and refuses a credential-bearing route", () => {
    const { fleet, database, digest } = fixture()
    const unsafe = "secret-in-machine-label"
    fleet.stageEnrollment({ ...facts, label: `token=${unsafe}` }, digest, 1_000)
    const stored = JSON.stringify(database.prepare("SELECT * FROM fleet_operations").all())
    expect(stored).not.toContain(unsafe)
    expect(stored).toContain("[REDACTED]")
    expect(() => fleet.stageEnrollment({
      ...facts, transports: [{ kind: "tailnet", endpoint: `wss://studio/rpc?token=${unsafe}`, authenticated: true }],
    }, digest, 1_000)).toThrow("Fleet endpoints cannot contain secrets")
  })

  it("makes forget visible while its keychain deletion is unfinished and resumes after restart", () => {
    const { fleet, database, digest } = fixture()
    const enrollment = fleet.stageEnrollment(facts, digest, 1_000)
    fleet.completeEnrollment(enrollment.id, digest)
    const forgetting = fleet.stageForget(remoteId, digest, 2_000)
    expect(fleet.snapshot(localId, 2_000).entries).toEqual([{
      kind: "pending", id: forgetting.id, machineId: remoteId, operation: "forget", startedAt: new Date(2_000).toISOString(),
    }])
    expect(fleet.enrolled()).toEqual([])
    expect(fleet.completeEnrollment(forgetting.id, digest)).toBe(false)
    const restarted = new SqliteFleetRegistry(database)
    expect(restarted.pendingOperations()).toEqual([forgetting])
    expect(restarted.confirmRemoteRevocation(forgetting.id)).toBe(true)
    expect(restarted.pendingOperations()[0]).toMatchObject({ remoteRevocation: "confirmed" })
    expect(restarted.completeForget(forgetting.id)).toBe(true)
    expect(restarted.snapshot(localId, 3_000).entries).toEqual([])
    expect(restarted.pendingOperations()).toEqual([])
    expect(restarted.completeForget(forgetting.id)).toBe(false)
  })

  it("does not resurrect or refresh a row from a late heartbeat during or after forget", () => {
    const { fleet, digest } = fixture()
    const enrollment = fleet.stageEnrollment(facts, digest, 1_000)
    fleet.completeEnrollment(enrollment.id, digest)
    const forgetting = fleet.stageForget(remoteId, digest, 2_000)
    expect(fleet.refreshAuthenticated(facts, digest, 3_000)).toBe(false)
    expect(fleet.recordFailure(remoteId, digest, "pairing-required")).toBe(false)
    fleet.completeForget(forgetting.id)
    expect(fleet.refreshAuthenticated(facts, digest, 4_000)).toBe(false)
    expect(fleet.recordFailure(remoteId, digest, "reconnecting")).toBe(false)
    expect(fleet.snapshot(localId, 4_000).entries).toEqual([])
  })

  it("fences old credentials after re-enrollment and only advances contact on authenticated facts", () => {
    const { fleet, digest } = fixture()
    const enrollment = fleet.stageEnrollment(facts, digest, 1_000)
    fleet.completeEnrollment(enrollment.id, digest)
    const nextDigest = machineCredentialDigest(remoteId, "z".repeat(43))
    const next = fleet.stageEnrollment({ ...facts, verifiedRoute: {
      endpoint: facts.verifiedRoute!.endpoint, lastAuthenticatedAt: new Date(2_000).toISOString(),
    } }, nextDigest, 2_000)
    expect(fleet.refreshAuthenticated(facts, digest, 2_100)).toBe(false)
    fleet.completeEnrollment(next.id, nextDigest)
    expect(fleet.refreshAuthenticated(facts, digest, 2_200)).toBe(false)
    expect(fleet.recordFailure(remoteId, nextDigest, "credential-store-unavailable")).toBe(true)
    expect(fleet.snapshot(localId, 3_000).entries[0]).toMatchObject({ machine: {
      health: "credential-store-unavailable", heartbeat: { lastSeenAt: new Date(2_000).toISOString() },
    } })
    const refreshed = { ...facts, label: "studio-renamed", verifiedRoute: {
      endpoint: "wss://studio.lan/rpc", lastAuthenticatedAt: new Date(4_000).toISOString(),
    } }
    expect(fleet.refreshAuthenticated(refreshed, nextDigest, 4_000)).toBe(true)
    expect(fleet.snapshot(localId, 4_000).entries[0]).toMatchObject({ machine: {
      label: refreshed.label, health: "healthy", verifiedRoute: refreshed.verifiedRoute,
      heartbeat: { lastSeenAt: new Date(4_000).toISOString() },
    } })
  })

  it("rolls back an unpromoted enrollment without pretending the previous credential still works", () => {
    const { fleet, digest } = fixture()
    const first = fleet.stageEnrollment(facts, digest, 1_000)
    fleet.completeEnrollment(first.id, digest)
    const replacement = fleet.stageEnrollment(facts, machineCredentialDigest(remoteId, "z".repeat(43)), 2_000)
    expect(fleet.abortEnrollment(replacement.id)).toBe(true)
    expect(fleet.snapshot(localId, 2_000).entries[0]).toMatchObject({ machine: { health: "pairing-required" } })
    expect(fleet.abortEnrollment(replacement.id)).toBe(false)
    const orphanId = `machine-${"c".repeat(32)}`
    expect(fleet.snapshot(localId, 2_000, [orphanId]).entries).toContainEqual({ kind: "unenrolled", machineId: orphanId })
  })

  it("does not allow overlapping operations on a machine", () => {
    const { fleet, digest } = fixture()
    const staged = fleet.stageEnrollment(facts, digest, 1_000)
    expect(() => fleet.stageEnrollment(facts, digest, 1_001)).toThrow(FleetOperationInProgressError)
    expect(() => fleet.stageForget(remoteId, digest, 1_001)).toThrow(FleetOperationInProgressError)
    expect(fleet.completeForget(staged.id)).toBe(false)
    expect(fleet.confirmRemoteRevocation(staged.id)).toBe(false)
    expect(fleet.snapshot(localId, 1_002, [remoteId, remoteId]).entries).toHaveLength(1)
  })

  it("forgets an orphan or already-missing credential without inventing target facts", () => {
    const { fleet } = fixture()
    const staged = fleet.stageForget(remoteId, null, 1_000)
    expect(staged).toMatchObject({ credentialDigest: null, remoteRevocation: "unconfirmed" })
    expect(fleet.snapshot(localId, 1_000).entries[0]).toMatchObject({ kind: "pending", machineId: remoteId })
    expect(fleet.completeForget(staged.id)).toBe(true)
  })

  it("binds the digest to both its domain and machine identity", () => {
    expect(machineCredentialDigest(remoteId, token)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(machineCredentialDigest(remoteId, token)).not.toBe(machineCredentialDigest(localId, token))
    expect(() => machineCredentialDigest(remoteId, "short")).toThrow("Machine credential is malformed")
  })
})
