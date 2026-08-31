import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import {
  DeviceLimitReachedError,
  DeviceNotFoundError,
  SqliteDeviceRegistry,
  maximumPairedDeviceLabelLength,
  maximumPairedDevices,
} from "./device-registry.js"

function registry(database = new DatabaseSync(":memory:")): {
  registry: SqliteDeviceRegistry
  database: DatabaseSync
} {
  return { registry: new SqliteDeviceRegistry(database), database }
}

describe("SqliteDeviceRegistry", () => {
  it("issues a high-entropy device credential exactly once", () => {
    const { registry: devices, database } = registry()

    const paired = devices.pair({ label: "studio-ipad" })

    expect(paired.device.id).toMatch(/^device-[0-9a-f]{32}$/)
    expect(paired.device.label).toBe("studio-ipad")
    expect(paired.device.revokedAt).toBeUndefined()
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = database.prepare("SELECT * FROM paired_devices").all()
    expect(JSON.stringify(rows)).not.toContain(paired.token)
    expect(devices.list()).toEqual([paired.device])
    expect(JSON.stringify(devices.list())).not.toMatch(/token|hash/i)
  })

  it("verifies an issued credential and records the last contact", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })

    const verified = devices.verify(paired.token)

    expect(verified?.id).toBe(paired.device.id)
    expect(verified?.lastSeenAt).toEqual(expect.any(String))
    expect(devices.list()[0]?.lastSeenAt).toBe(verified?.lastSeenAt)
  })

  it("rejects an unknown credential", () => {
    const { registry: devices } = registry()
    devices.pair({ label: "studio-ipad" })

    expect(devices.verify("z".repeat(43))).toBeUndefined()
    expect(devices.verify("")).toBeUndefined()
  })

  it("rejects the credential of a revoked device", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })

    const revoked = devices.revoke(paired.device.id)

    expect(revoked.revokedAt).toEqual(expect.any(String))
    expect(devices.verify(paired.token)).toBeUndefined()
  })

  it("keeps a revoked device listed so its history stays auditable", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })

    devices.revoke(paired.device.id)

    expect(devices.list()).toEqual([
      expect.objectContaining({ id: paired.device.id, revokedAt: expect.any(String) }),
    ])
  })

  it("rejects the previous credential after rotation", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })

    const rotated = devices.rotate(paired.device.id)

    expect(rotated.token).not.toBe(paired.token)
    expect(rotated.device.id).toBe(paired.device.id)
    expect(devices.verify(paired.token)).toBeUndefined()
    expect(devices.verify(rotated.token)?.id).toBe(paired.device.id)
  })

  it("refuses to rotate or revoke an unknown device", () => {
    const { registry: devices } = registry()

    expect(() => devices.rotate("device-missing")).toThrow(DeviceNotFoundError)
    expect(() => devices.revoke("device-missing")).toThrow(DeviceNotFoundError)
  })

  it("refuses to rotate a revoked device", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })
    devices.revoke(paired.device.id)

    expect(() => devices.rotate(paired.device.id)).toThrow(DeviceNotFoundError)
  })

  it("keeps credentials usable across daemon restarts", () => {
    const database = new DatabaseSync(":memory:")
    const paired = new SqliteDeviceRegistry(database).pair({ label: "studio-ipad" })

    const restarted = new SqliteDeviceRegistry(database)

    expect(restarted.verify(paired.token)?.id).toBe(paired.device.id)
  })

  it("bounds the number of paired devices", () => {
    const { registry: devices } = registry()
    for (let index = 0; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}` })
    }

    expect(() => devices.pair({ label: "one-too-many" })).toThrow(DeviceLimitReachedError)
  })

  it("does not count revoked devices against the pairing limit", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad" })
    for (let index = 1; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}` })
    }
    devices.revoke(paired.device.id)

    expect(() => devices.pair({ label: "replacement" })).not.toThrow()
  })

  it("accepts a maximum-length label with surrounding whitespace", () => {
    const { registry: devices } = registry()

    expect(devices.pair({ label: `  ${"n".repeat(maximumPairedDeviceLabelLength)}  ` }).device.label)
      .toBe("n".repeat(maximumPairedDeviceLabelLength))
  })

  it.each(["", "   ", "n".repeat(129)])("rejects an unusable device label: %s", (label) => {
    const { registry: devices } = registry()

    expect(() => devices.pair({ label })).toThrow("Device label is invalid")
  })
})
