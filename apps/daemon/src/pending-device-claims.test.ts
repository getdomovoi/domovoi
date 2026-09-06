import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { maximumPairedDevices, pendingDeviceClaimTtlMs, SqliteDeviceRegistry } from "./device-registry.js"

const machineId = `machine-${"a".repeat(32)}`
const otherId = `machine-${"b".repeat(32)}`
const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
function fixture() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  return { database, devices: new SqliteDeviceRegistry(database) }
}

describe("durable pending device claims", () => {
  it("confirms once after a registry restart and acknowledges a lost confirmation reply", () => {
    const { database, devices } = fixture()
    const pending = devices.claim({ label: "source", machineId }, 1_000)
    expect(devices.verify(pending.token)).toBeUndefined()
    const restarted = new SqliteDeviceRegistry(database)
    const device = restarted.confirmClaim(pending.token, machineId, 2_000)
    expect(device).toMatchObject({ id: pending.claim.deviceId, pairedAt: new Date(2_000).toISOString() })
    expect(restarted.verify(pending.token)?.device).toEqual(device)
    expect(restarted.confirmClaim(pending.token, machineId, 999_000)).toEqual(device)
    expect(restarted.list()).toEqual([device])
    expect(database.prepare("SELECT * FROM pending_device_claims").all()).toEqual([])
  })

  it("expires unconfirmed authority at the boundary even across restart without a cleanup timer", () => {
    const { database, devices } = fixture()
    const pending = devices.claim({ label: "source", machineId }, 1_000)
    const restarted = new SqliteDeviceRegistry(database)
    expect(restarted.confirmClaim(pending.token, machineId, 1_000 + pendingDeviceClaimTtlMs)).toBeUndefined()
    expect(restarted.isActive(pending.token)).toBe(false)
    expect(restarted.list()).toEqual([])
    expect(database.prepare("SELECT * FROM pending_device_claims").all()).toEqual([])
  })

  it("does not activate on a different source identity, and cannot revive a revoked or rotated credential", () => {
    const { devices } = fixture()
    const pending = devices.claim({ label: "source", machineId }, 1_000)
    expect(devices.confirmClaim(pending.token, otherId, 2_000)).toBeUndefined()
    expect(devices.isActive(pending.token)).toBe(false)
    const device = devices.confirmClaim(pending.token, machineId, 2_000)!
    const rotated = devices.rotate(device.id)
    expect(devices.confirmClaim(pending.token, machineId, 3_000)).toBeUndefined()
    devices.revoke(device.id)
    expect(devices.confirmClaim(rotated.token, machineId, 3_000)).toBeUndefined()
  })

  it("invalidates superseded pending capabilities without retiring the active one until confirmation", () => {
    const { devices } = fixture()
    const active = devices.pair({ label: "original", binding: { kind: "machine", machineId } })
    const old = devices.claim({ label: "old pending", machineId }, 1_000)
    const latest = devices.claim({ label: "latest", machineId }, 2_000)
    expect(devices.confirmClaim(old.token, machineId, 3_000)).toBeUndefined()
    expect(devices.isActive(active.token)).toBe(true)
    expect(devices.confirmClaim(latest.token, machineId, 3_000)?.label).toBe("latest")
    expect(devices.isActive(active.token)).toBe(false)
  })

  it("stores only hashes and bounds abandoned claims independently of active devices", () => {
    const { database, devices } = fixture()
    const token = devices.claim({ label: "source", machineId }, 1_000).token
    expect(JSON.stringify(database.prepare("SELECT * FROM pending_device_claims").all())).not.toContain(token)
    for (let index = 1; index < maximumPairedDevices; index += 1) {
      devices.claim({ label: "source", machineId: `machine-${index.toString(16).padStart(32, "0")}` }, 1_000)
    }
    expect(() => devices.claim({ label: "overflow", machineId: otherId }, 1_000)).toThrow("limit")
    expect(devices.list()).toEqual([])
    expect(() => devices.claim({ label: "expired slots", machineId: otherId }, 1_000 + pendingDeviceClaimTtlMs)).not.toThrow()
    expect(database.prepare("SELECT * FROM pending_device_claims").all()).toHaveLength(1)
  })
})
