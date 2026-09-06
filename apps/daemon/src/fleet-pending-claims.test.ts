import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { daemonAuthenticationErrorCode, deviceClaimResultSchema, deviceIssueCodeResultSchema, fleetSnapshotSchema, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { pendingDeviceClaimTtlMs, SqliteDeviceRegistry } from "./device-registry.js"
import { fleetProductionHarness, persistedRegistry } from "./test-fleet-production.js"
import { waitForDaemon } from "./test-wait-for.js"

const { cleanup, machine, connect } = fleetProductionHarness()
afterEach(async () => { vi.restoreAllMocks(); await cleanup() })

function devices<T>(homeDirectory: string, read: (registry: SqliteDeviceRegistry) => T): T {
  const database = new DatabaseSync(join(homeDirectory, ".domovoi", "state.sqlite"))
  try { return read(new SqliteDeviceRegistry(database)) }
  finally { database.close() }
}

describe("pending claims in the production fleet", () => {
  it("leaves no active remote credential when local storage fails, even after target restart", async () => {
    const source = await machine("source")
    const target = await machine("target")
    let unkept: string | undefined
    vi.spyOn(source.credentials, "save").mockImplementation((_id, token) => { unkept = token; throw new Error("keychain denied write") })
    const code = deviceIssueCodeResultSchema.parse(await target.root.ok("device.issueCode", {}))
    expect(await source.root.ok("fleet.enroll", {
      endpoint: target.address.url, code: code.code, sourceDeviceLabel: "source", expectedMachineId: target.id, client: "cli",
    })).toMatchObject({ outcome: "refused", reason: "credential-store-unavailable" })
    expect(unkept).toBeDefined()
    expect(source.credentials.forMachine(target.id)).toBeUndefined()
    expect(devices(target.homeDirectory, (registry) => registry.list())).toEqual([])
    await target.handle.stop()
    const restarted = await target.start({ port: target.address.port })
    expect(devices(target.homeDirectory, (registry) => registry.isActive(unkept!))).toBe(false)
    expect(devices(target.homeDirectory, (registry) => registry.confirmClaim(unkept!, source.id, Date.now() + pendingDeviceClaimTtlMs))).toBeUndefined()
    const claimant = await connect(restarted.address.url)
    expect((await claimant.call("device.confirmClaim", { authToken: unkept!, machineId: source.id, protocolVersion })).error?.code)
      .toBe(daemonAuthenticationErrorCode)
    expect(await restarted.root.ok("device.list", {})).toEqual({ devices: [] })
  }, 20_000)

  it("recovers a committed confirmation with its lost reply after source restart", async () => {
    const source = await machine("source")
    const target = await machine("target")
    const confirm = SqliteDeviceRegistry.prototype.confirmClaim
    let committedId: string | undefined
    const interruption = vi.spyOn(SqliteDeviceRegistry.prototype, "confirmClaim").mockImplementation(function (this: SqliteDeviceRegistry, token, id, now) {
      const device = confirm.call(this, token, id, now)
      if (id === source.id && device) {
        // The actual target commits but cannot deliver a successful reply.
        // Repeats stay ambiguous until the source has stopped for restart.
        expect(source.credentials.forMachine(target.id)).toBe(token)
        expect(persistedRegistry(source.homeDirectory, (registry) => registry.pendingOperations())).toHaveLength(1)
        committedId = device.id
        throw new Error("injected interruption after target commit")
      }
      return device
    })
    const code = deviceIssueCodeResultSchema.parse(await target.root.ok("device.issueCode", {}))
    expect(await source.root.ok("fleet.enroll", {
      endpoint: target.address.url, code: code.code, sourceDeviceLabel: "source", expectedMachineId: target.id, client: "cli",
    })).toMatchObject({ outcome: "pending" })
    expect(committedId).toBeDefined()
    const token = source.credentials.forMachine(target.id)!
    expect(devices(target.homeDirectory, (registry) => registry.isActive(token))).toBe(true)
    expect(persistedRegistry(source.homeDirectory, (registry) => registry.enrolled())).toEqual([])
    await source.handle.stop()
    interruption.mockRestore()
    const restarted = await source.start()
    await waitForDaemon(async () => {
      const snapshot = fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {}))
      expect(snapshot.entries).toContainEqual(expect.objectContaining({ kind: "machine", machine: expect.objectContaining({ id: target.id }) }))
    })
    expect(devices(target.homeDirectory, (registry) => registry.list())).toMatchObject([{ id: committedId }])
    expect(persistedRegistry(source.homeDirectory, (registry) => registry.pendingOperations())).toEqual([])
  }, 20_000)

  it("a claimed but never stored capability cannot outlive expiry or spend another code", async () => {
    const target = await machine("target")
    const claimant = await connect(target.address.url)
    const sourceId = `machine-${"a".repeat(32)}`
    const issued = deviceIssueCodeResultSchema.parse(await target.root.ok("device.issueCode", {}))
    const pending = deviceClaimResultSchema.parse(await claimant.ok("device.claim", {
      code: issued.code, label: "abandoned", machineId: sourceId, protocolVersion,
    }))
    expect(devices(target.homeDirectory, (registry) => registry.verify(pending.token))).toBeUndefined()
    const nextCode = deviceIssueCodeResultSchema.parse(await target.root.ok("device.issueCode", {}))
    devices(target.homeDirectory, (registry) => registry.confirmClaim(pending.token, sourceId, Date.parse(pending.claim.expiresAt)))
    const expired = await claimant.call("device.confirmClaim", { authToken: pending.token, machineId: sourceId, protocolVersion })
    const unknown = await claimant.call("device.confirmClaim", { authToken: "n".repeat(43), machineId: sourceId, protocolVersion })
    expect(expired.error).toEqual(unknown.error)
    expect(expired.error?.code).toBe(daemonAuthenticationErrorCode)
    expect(deviceClaimResultSchema.parse(await claimant.ok("device.claim", { code: nextCode.code, label: "retry", machineId: sourceId, protocolVersion })).claim.state).toBe("pending")
  }, 20_000)
})
