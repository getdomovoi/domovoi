import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"

import { SqliteDeviceRegistry } from "./device-registry.js"

const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
const key = Buffer.alloc(32, 11).toString("base64url")

function fixture() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  return { database, devices: new SqliteDeviceRegistry(database) }
}

describe("durable relay device binding", () => {
  it("keeps the paired public key with the same credential through restart and rotation", () => {
    const { database, devices } = fixture()
    const pairing = devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: key })
    expect(devices.verify(pairing.token)).toHaveProperty("channelPublicKey", key)
    expect(pairing.device).not.toHaveProperty("channelPublicKey")
    const restarted = new SqliteDeviceRegistry(database)
    expect(restarted.verify(pairing.token)).toHaveProperty("channelPublicKey", key)
    const rotated = restarted.rotate(pairing.device.id)
    expect(restarted.verify(pairing.token)).toBeUndefined()
    expect(restarted.verify(rotated.token)).toHaveProperty("channelPublicKey", key)
    restarted.revoke(pairing.device.id)
    expect(restarted.verify(rotated.token)).toBeUndefined()
  })

  it("binds a pending machine key only when confirmation grants authority", () => {
    const { database, devices } = fixture()
    const machineId = `machine-${"a".repeat(32)}`
    const pending = devices.claim({ label: "machine", machineId, channelPublicKey: key }, 0)
    expect(devices.verify(pending.token)).toBeUndefined()
    const restarted = new SqliteDeviceRegistry(database)
    expect(restarted.confirmClaim(pending.token, machineId, 1)).toBeDefined()
    expect(restarted.verify(pending.token)).toHaveProperty("channelPublicKey", key)
  })

  it("does not invent a channel key for a pre-existing direct pairing", () => {
    const { database, devices } = fixture()
    const paired = devices.pair({ label: "legacy", binding: { kind: "client", client: "cli" } })
    expect(new SqliteDeviceRegistry(database).verify(paired.token)).not.toHaveProperty("channelPublicKey")
  })

  it("refuses malformed public keys before publishing a credential or a pending claim", () => {
    const { devices } = fixture()
    expect(() => devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: "bad" })).toThrow()
    expect(() => devices.claim({ label: "machine", machineId: `machine-${"a".repeat(32)}`, channelPublicKey: "bad" }, 0)).toThrow()
    expect(devices.list()).toEqual([])
  })
})
