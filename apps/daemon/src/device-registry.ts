import { createHash, randomBytes } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { machineIdSchema } from "@getdomovoi/protocol"

export type PairedDevice = {
  id: string
  label: string
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
  revocationReason?: "legacy-unbound-credential"
}

export type DevicePairing = {
  device: PairedDevice
  token: string
}

export type DeviceCredentialBinding =
  | { kind: "client" }
  | { kind: "machine"; machineId: string }

export type VerifiedDeviceCredential = {
  device: PairedDevice
  binding: DeviceCredentialBinding
}

export const maximumPairedDevices = 128
export const maximumPairedDeviceLabelLength = 128

export interface DeviceRegistry {
  pair(input: { label: string; binding: DeviceCredentialBinding }): DevicePairing
  verify(token: string): VerifiedDeviceCredential | undefined
  isActive(token: string): boolean
  rotate(deviceId: string): DevicePairing
  revoke(deviceId: string): PairedDevice
  list(): PairedDevice[]
}

export class DeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Paired device not found: ${deviceId}`)
    this.name = "DeviceNotFoundError"
  }
}

export class DeviceLimitReachedError extends Error {
  constructor() {
    super(`Paired device limit of ${maximumPairedDevices} reached`)
    this.name = "DeviceLimitReachedError"
  }
}

type StoredDevice = {
  id: string
  label: string
  paired_at: string
  last_seen_at: string | null
  revoked_at: string | null
  revocation_reason: string | null
  credential_role: string
  machine_id: string | null
}

function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function validateLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > maximumPairedDeviceLabelLength) {
    throw new Error("Device label is invalid")
  }
  return trimmed
}

function toPairedDevice(row: StoredDevice): PairedDevice {
  return {
    id: row.id,
    label: row.label,
    pairedAt: row.paired_at,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.revocation_reason === "legacy-unbound-credential"
      ? { revocationReason: row.revocation_reason }
      : {}),
  }
}

function credentialBinding(row: StoredDevice): DeviceCredentialBinding | undefined {
  if (row.credential_role === "client" && row.machine_id === null) return { kind: "client" }
  if (row.credential_role !== "machine") return undefined
  const machineId = machineIdSchema.safeParse(row.machine_id)
  return machineId.success ? { kind: "machine", machineId: machineId.data } : undefined
}

export class SqliteDeviceRegistry implements DeviceRegistry {
  #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS paired_devices (
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
      CREATE INDEX IF NOT EXISTS paired_devices_revoked_at ON paired_devices (revoked_at);
    `)
    const columns = this.#database.prepare("PRAGMA table_info(paired_devices)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "credential_role")) {
      // The old table mixed client and daemon-to-daemon credentials. There is
      // no sound way to infer which authority an existing token held, so the
      // migration gives it no reusable role and revokes it below.
      this.#database.exec("ALTER TABLE paired_devices ADD COLUMN credential_role TEXT NOT NULL DEFAULT 'legacy'")
    }
    if (!columns.some((column) => column.name === "machine_id")) {
      this.#database.exec("ALTER TABLE paired_devices ADD COLUMN machine_id TEXT")
    }
    if (!columns.some((column) => column.name === "revocation_reason")) {
      this.#database.exec("ALTER TABLE paired_devices ADD COLUMN revocation_reason TEXT")
    }
    this.#database.prepare(`
      UPDATE paired_devices
      SET revoked_at = COALESCE(revoked_at, ?),
          revocation_reason = 'legacy-unbound-credential'
      WHERE credential_role = 'legacy'
    `).run(new Date().toISOString())
  }

  pair(input: { label: string; binding: DeviceCredentialBinding }): DevicePairing {
    const label = validateLabel(input.label)
    if (input.binding.kind === "machine") machineIdSchema.parse(input.binding.machineId)
    const active = this.#database
      .prepare("SELECT COUNT(*) AS total FROM paired_devices WHERE revoked_at IS NULL")
      .get() as { total: number }
    if (active.total >= maximumPairedDevices) throw new DeviceLimitReachedError()

    const token = randomBytes(32).toString("base64url")
    const device: PairedDevice = {
      id: `device-${randomBytes(16).toString("hex")}`,
      label,
      pairedAt: new Date().toISOString(),
    }
    this.#database
      .prepare(`
        INSERT INTO paired_devices (
          id, label, token_hash, paired_at, credential_role, machine_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        device.id,
        device.label,
        hashDeviceToken(token),
        device.pairedAt,
        input.binding.kind,
        input.binding.kind === "machine" ? input.binding.machineId : null,
      )
    return { device, token }
  }

  verify(token: string): VerifiedDeviceCredential | undefined {
    if (!token) return undefined
    const row = this.#database
      .prepare("SELECT * FROM paired_devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashDeviceToken(token)) as StoredDevice | undefined
    if (!row) return undefined
    const binding = credentialBinding(row)
    if (!binding) return undefined

    const lastSeenAt = new Date().toISOString()
    this.#database
      .prepare("UPDATE paired_devices SET last_seen_at = ? WHERE id = ?")
      .run(lastSeenAt, row.id)
    return { device: toPairedDevice({ ...row, last_seen_at: lastSeenAt }), binding }
  }

  isActive(token: string): boolean {
    if (!token) return false
    const row = this.#database
      .prepare("SELECT * FROM paired_devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashDeviceToken(token)) as StoredDevice | undefined
    return row !== undefined && credentialBinding(row) !== undefined
  }

  rotate(deviceId: string): DevicePairing {
    const row = this.#database
      .prepare("SELECT * FROM paired_devices WHERE id = ? AND revoked_at IS NULL")
      .get(deviceId) as StoredDevice | undefined
    if (!row) throw new DeviceNotFoundError(deviceId)

    const token = randomBytes(32).toString("base64url")
    this.#database
      .prepare("UPDATE paired_devices SET token_hash = ? WHERE id = ?")
      .run(hashDeviceToken(token), deviceId)
    return { device: toPairedDevice(row), token }
  }

  revoke(deviceId: string): PairedDevice {
    const row = this.#database
      .prepare("SELECT * FROM paired_devices WHERE id = ?")
      .get(deviceId) as StoredDevice | undefined
    if (!row) throw new DeviceNotFoundError(deviceId)

    const revokedAt = row.revoked_at ?? new Date().toISOString()
    this.#database
      .prepare("UPDATE paired_devices SET revoked_at = ? WHERE id = ?")
      .run(revokedAt, deviceId)
    return toPairedDevice({ ...row, revoked_at: revokedAt })
  }

  list(): PairedDevice[] {
    const rows = this.#database
      .prepare("SELECT * FROM paired_devices ORDER BY paired_at ASC, id ASC")
      .all() as StoredDevice[]
    return rows.map(toPairedDevice)
  }
}
