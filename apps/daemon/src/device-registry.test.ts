import { createHash } from "node:crypto"
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
  it("keeps client and machine credential authority distinct", () => {
    const { registry: devices } = registry()
    const machineId = `machine-${"a".repeat(32)}`
    const client = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })
    const machine = devices.pair({ label: "studio-mac", binding: { kind: "machine", machineId } })

    expect(devices.verify(client.token)).toEqual({
      device: expect.objectContaining({ id: client.device.id }),
      binding: { kind: "client" },
    })
    expect(devices.verify(machine.token)).toEqual({
      device: expect.objectContaining({ id: machine.device.id }),
      binding: { kind: "machine", machineId },
    })
  })

  it("persists a machine credential binding through restart and rotation", () => {
    const database = new DatabaseSync(":memory:")
    const machineId = `machine-${"b".repeat(32)}`
    const first = new SqliteDeviceRegistry(database)
    const paired = first.pair({ label: "studio-mac", binding: { kind: "machine", machineId } })
    const rotated = first.rotate(paired.device.id)

    const restarted = new SqliteDeviceRegistry(database)

    expect(restarted.verify(paired.token)).toBeUndefined()
    expect(restarted.verify(rotated.token)).toEqual({
      device: expect.objectContaining({ id: paired.device.id }),
      binding: { kind: "machine", machineId },
    })
  })

  it("revokes ambiguous legacy credentials instead of granting client authority", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE paired_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
    `)
    const token = "n".repeat(43)
    database.prepare(`
      INSERT INTO paired_devices (id, label, token_hash, paired_at)
      VALUES (?, ?, ?, ?)
    `).run(
      `device-${"c".repeat(32)}`,
      "legacy peer",
      createHash("sha256").update(token).digest("hex"),
      "2026-09-03T12:00:00.000Z",
    )
    const devices = new SqliteDeviceRegistry(database)
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    expect(devices.verify(token)).toBeUndefined()
    expect(devices.isActive(token)).toBe(false)
    expect(devices.list()).toContainEqual(expect.objectContaining({
      label: "legacy peer",
      revokedAt: expect.any(String),
      revocationReason: "legacy-unbound-credential",
    }))
    expect(devices.verify(paired.token)?.binding).toEqual({ kind: "client" })
    expect(database.prepare("SELECT credential_role, machine_id FROM paired_devices WHERE id = ?")
      .get(paired.device.id)).toEqual({ credential_role: "client", machine_id: null })
  })

  it("issues a high-entropy device credential exactly once", () => {
    const { registry: devices, database } = registry()

    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

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
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    const verified = devices.verify(paired.token)

    expect(verified?.device.id).toBe(paired.device.id)
    expect(verified?.device.lastSeenAt).toEqual(expect.any(String))
    expect(devices.list()[0]?.lastSeenAt).toBe(verified?.device.lastSeenAt)
  })

  it("rejects an unknown credential", () => {
    const { registry: devices } = registry()
    devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    expect(devices.verify("z".repeat(43))).toBeUndefined()
    expect(devices.verify("")).toBeUndefined()
  })

  it("rejects the credential of a revoked device", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    const revoked = devices.revoke(paired.device.id)

    expect(revoked.revokedAt).toEqual(expect.any(String))
    expect(devices.verify(paired.token)).toBeUndefined()
  })

  it("keeps a revoked device listed so its history stays auditable", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    devices.revoke(paired.device.id)

    expect(devices.list()).toEqual([
      expect.objectContaining({ id: paired.device.id, revokedAt: expect.any(String) }),
    ])
  })

  it("rejects the previous credential after rotation", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })

    const rotated = devices.rotate(paired.device.id)

    expect(rotated.token).not.toBe(paired.token)
    expect(rotated.device.id).toBe(paired.device.id)
    expect(devices.verify(paired.token)).toBeUndefined()
    expect(devices.verify(rotated.token)?.device.id).toBe(paired.device.id)
  })

  it("refuses to rotate or revoke an unknown device", () => {
    const { registry: devices } = registry()

    expect(() => devices.rotate("device-missing")).toThrow(DeviceNotFoundError)
    expect(() => devices.revoke("device-missing")).toThrow(DeviceNotFoundError)
  })

  it("refuses to rotate a revoked device", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })
    devices.revoke(paired.device.id)

    expect(() => devices.rotate(paired.device.id)).toThrow(DeviceNotFoundError)
  })

  it("keeps credentials usable across daemon restarts", () => {
    const database = new DatabaseSync(":memory:")
    const paired = new SqliteDeviceRegistry(database).pair({
      label: "studio-ipad",
      binding: { kind: "client" },
    })

    const restarted = new SqliteDeviceRegistry(database)

    expect(restarted.verify(paired.token)?.device.id).toBe(paired.device.id)
  })

  it("bounds the number of paired devices", () => {
    const { registry: devices } = registry()
    for (let index = 0; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}`, binding: { kind: "client" } })
    }

    expect(() => devices.pair({ label: "one-too-many", binding: { kind: "client" } }))
      .toThrow(DeviceLimitReachedError)
  })

  it("does not count revoked devices against the pairing limit", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client" } })
    for (let index = 1; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}`, binding: { kind: "client" } })
    }
    devices.revoke(paired.device.id)

    expect(() => devices.pair({ label: "replacement", binding: { kind: "client" } })).not.toThrow()
  })

  it("accepts a maximum-length label with surrounding whitespace", () => {
    const { registry: devices } = registry()

    expect(devices.pair({
      label: `  ${"n".repeat(maximumPairedDeviceLabelLength)}  `,
      binding: { kind: "client" },
    }).device.label)
      .toBe("n".repeat(maximumPairedDeviceLabelLength))
  })

  it.each(["", "   ", "n".repeat(129)])("rejects an unusable device label: %s", (label) => {
    const { registry: devices } = registry()

    expect(() => devices.pair({ label, binding: { kind: "client" } })).toThrow("Device label is invalid")
  })
})
