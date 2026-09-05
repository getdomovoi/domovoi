import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import {
  DeviceLimitReachedError,
  DeviceNotFoundError,
  SqliteDeviceRegistry,
  maximumDeviceRenameLabelLength,
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
    const client = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })
    const machine = devices.pair({ label: "studio-mac", binding: { kind: "machine", machineId } })

    expect(devices.verify(client.token)).toEqual({
      device: expect.objectContaining({ id: client.device.id }),
      binding: { kind: "client", client: "phone" },
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
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    expect(devices.verify(token)).toBeUndefined()
    expect(devices.isActive(token)).toBe(false)
    expect(devices.list()).toContainEqual(expect.objectContaining({
      label: "legacy peer",
      binding: { kind: "unbound", previousRole: "unknown" },
      revokedAt: expect.any(String),
      revocationReason: "legacy-unbound-credential",
    }))
    expect(devices.verify(paired.token)?.binding).toEqual({ kind: "client", client: "phone" })
    expect(database.prepare("SELECT credential_role, client_kind, machine_id FROM paired_devices WHERE id = ?")
      .get(paired.device.id)).toEqual({
        credential_role: "client",
        client_kind: "phone",
        machine_id: null,
      })
  })

  it("revokes client credentials created before their client kind was bound", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE paired_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        revocation_reason TEXT,
        credential_role TEXT NOT NULL,
        machine_id TEXT
      );
    `)
    const token = "n".repeat(43)
    database.prepare(`
      INSERT INTO paired_devices (
        id, label, token_hash, paired_at, credential_role, machine_id
      ) VALUES (?, ?, ?, ?, 'client', NULL)
    `).run(
      `device-${"d".repeat(32)}`,
      "pre-kind phone",
      createHash("sha256").update(token).digest("hex"),
      "2026-09-04T12:00:00.000Z",
    )

    const devices = new SqliteDeviceRegistry(database)

    expect(devices.verify(token)).toBeUndefined()
    expect(devices.list()).toContainEqual(expect.objectContaining({
      label: "pre-kind phone",
      binding: { kind: "unbound", previousRole: "client" },
      revokedAt: expect.any(String),
      revocationReason: "legacy-unbound-client-kind",
    }))
  })

  it("issues a high-entropy device credential exactly once", () => {
    const { registry: devices, database } = registry()

    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    expect(paired.device.id).toMatch(/^device-[0-9a-f]{32}$/)
    expect(paired.device.label).toBe("studio-ipad")
    expect(paired.device.revokedAt).toBeUndefined()
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = database.prepare("SELECT * FROM paired_devices").all()
    expect(JSON.stringify(rows)).not.toContain(paired.token)
    expect(devices.list()).toEqual([paired.device])
    expect(JSON.stringify(devices.list())).not.toMatch(/token|hash/i)
  })

  it("records contact only after an accepted hello marks the device seen", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    const verified = devices.verify(paired.token)

    expect(verified?.device.id).toBe(paired.device.id)
    expect(verified?.device.lastSeenAt).toBeUndefined()
    expect(devices.list()[0]?.lastSeenAt).toBeUndefined()

    const acceptedAt = "2026-09-04T12:30:00.000Z"
    devices.markSeen(paired.device.id, acceptedAt)

    expect(devices.list()[0]?.lastSeenAt).toBe(acceptedAt)
  })

  it("rejects an unknown credential", () => {
    const { registry: devices } = registry()
    devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    expect(devices.verify("z".repeat(43))).toBeUndefined()
    expect(devices.verify("")).toBeUndefined()
  })

  it("rejects the credential of a revoked device", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    const revoked = devices.revoke(paired.device.id)

    expect(revoked.revokedAt).toEqual(expect.any(String))
    expect(devices.verify(paired.token)).toBeUndefined()
  })

  it("keeps a revoked device listed so its history stays auditable", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

    devices.revoke(paired.device.id)

    expect(devices.list()).toEqual([
      expect.objectContaining({ id: paired.device.id, revokedAt: expect.any(String) }),
    ])
  })

  it("rejects the previous credential after rotation", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })

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
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })
    devices.revoke(paired.device.id)

    expect(() => devices.rotate(paired.device.id)).toThrow(DeviceNotFoundError)
  })

  it("renames a device and changes nothing but its label", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({
      label: "studio-ipad",
      binding: { kind: "machine", machineId: `machine-${"c".repeat(32)}` },
    })
    devices.markSeen(paired.device.id, "2026-09-04T08:00:00.000Z")
    const before = devices.list()[0]!

    const renamed = devices.rename(paired.device.id, "  kitchen-ipad  ")

    expect(renamed).toEqual({ ...before, label: "kitchen-ipad" })
    expect(devices.list()).toEqual([{ ...before, label: "kitchen-ipad" }])
    expect(devices.verify(paired.token)).toEqual({
      device: { ...before, label: "kitchen-ipad" },
      binding: { kind: "machine", machineId: `machine-${"c".repeat(32)}` },
    })
  })

  it("keeps a renamed label across a store reload", () => {
    const database = new DatabaseSync(":memory:")
    const first = new SqliteDeviceRegistry(database)
    const paired = first.pair({ label: "studio-ipad", binding: { kind: "client", client: "tablet" } })
    first.rename(paired.device.id, "kitchen-ipad")

    const restarted = new SqliteDeviceRegistry(database)

    expect(restarted.list()).toEqual([{ ...paired.device, label: "kitchen-ipad" }])
  })

  it("keeps the label of a revoked device editable for the record", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "tablet" } })
    const revoked = devices.revoke(paired.device.id)

    expect(devices.rename(paired.device.id, "old ipad")).toEqual({ ...revoked, label: "old ipad" })
    expect(devices.verify(paired.token)).toBeUndefined()
  })

  it("refuses to rename an unknown device", () => {
    const { registry: devices } = registry()

    expect(() => devices.rename("device-missing", "kitchen-ipad")).toThrow(DeviceNotFoundError)
  })

  it.each(["", "   ", "n".repeat(maximumDeviceRenameLabelLength + 1), "kitchen\u0000ipad"])(
    "refuses an unusable rename label: %s",
    (label) => {
      const { registry: devices } = registry()
      const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "tablet" } })

      expect(() => devices.rename(paired.device.id, label)).toThrow("Device label is invalid")
      expect(devices.list()).toEqual([paired.device])
    },
  )

  it("keeps credentials usable across daemon restarts", () => {
    const database = new DatabaseSync(":memory:")
    const paired = new SqliteDeviceRegistry(database).pair({
      label: "studio-ipad",
      binding: { kind: "client", client: "phone" },
    })

    const restarted = new SqliteDeviceRegistry(database)

    expect(restarted.verify(paired.token)?.device.id).toBe(paired.device.id)
  })

  it("bounds the number of paired devices", () => {
    const { registry: devices } = registry()
    for (let index = 0; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}`, binding: { kind: "client", client: "phone" } })
    }

    expect(() => devices.pair({ label: "one-too-many", binding: { kind: "client", client: "phone" } }))
      .toThrow(DeviceLimitReachedError)
  })

  it("does not count revoked devices against the pairing limit", () => {
    const { registry: devices } = registry()
    const paired = devices.pair({ label: "studio-ipad", binding: { kind: "client", client: "phone" } })
    for (let index = 1; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device-${index}`, binding: { kind: "client", client: "phone" } })
    }
    devices.revoke(paired.device.id)

    expect(() => devices.pair({ label: "replacement", binding: { kind: "client", client: "phone" } })).not.toThrow()
  })

  it("accepts a maximum-length label with surrounding whitespace", () => {
    const { registry: devices } = registry()

    expect(devices.pair({
      label: `  ${"n".repeat(maximumPairedDeviceLabelLength)}  `,
      binding: { kind: "client", client: "phone" },
    }).device.label)
      .toBe("n".repeat(maximumPairedDeviceLabelLength))
  })

  it.each(["", "   ", "n".repeat(129)])("rejects an unusable device label: %s", (label) => {
    const { registry: devices } = registry()

    expect(() => devices.pair({ label, binding: { kind: "client", client: "phone" } })).toThrow("Device label is invalid")
  })
})
