import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"
import { protocolVersion, type FleetMachineDescriptor } from "@getdomovoi/protocol"

import { FleetEnrollmentService } from "./fleet-enrollment.js"
import { SqliteFleetRegistry } from "./fleet-registry.js"
import { MachineCredentialStore, machineCredentialDigest } from "./machine-credentials.js"
import { MachinePairingRequiredError } from "./machine-socket.js"

const sourceId = `machine-${"a".repeat(32)}`
const targetId = `machine-${"b".repeat(32)}`
const token = "n".repeat(43)
const endpoint = "wss://studio.magicdns/rpc"
const descriptor: FleetMachineDescriptor = {
  id: targetId, label: "studio", platform: "darwin", arch: "arm64", version: "0.0.1", protocolVersion,
  capabilities: ["sessions", "worktrees"], transports: [],
}
const params = { endpoint, code: "hearth-quiet-ember-42", sourceDeviceLabel: "source", client: "cli" as const }
const databases: DatabaseSync[] = []
const services: FleetEnrollmentService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const registry = new SqliteFleetRegistry(database)
  const values = new Map<string, string>()
  const keyring = {
    get: vi.fn((id: string) => values.get(id)),
    set: vi.fn((id: string, value: string) => { values.set(id, value) }),
    delete: vi.fn((id: string) => { values.delete(id) }),
  }
  const credentials = new MachineCredentialStore(keyring)
  const call = vi.fn(async (method: string): Promise<unknown> => method === "device.revokeCurrent" ? { revoked: true } : descriptor)
  const close = vi.fn()
  const open = vi.fn(async () => ({ call, close }))
  const claim = vi.fn(async () => ({ connection: { call, close }, credential: token, descriptor, endpoint }))
  const changed = vi.fn()
  let now = 1_000
  const create = () => {
    const service = new FleetEnrollmentService({
      selfId: sourceId, registry, credentials, claim, open, changed,
      now: () => now, operationTimeoutMs: 1_000, heartbeatIntervalMs: 15_000,
    })
    services.push(service)
    return service
  }
  return { service: create(), create, registry, database, credentials, values, keyring, claim, open, call, close, changed, time: (value: number) => { now = value } }
}

describe("fleet enrollment coordinator", () => {
  it("publishes only authenticated facts and a separately observed route after matching keychain readback", async () => {
    const f = fixture()
    const save = f.credentials.save.bind(f.credentials)
    vi.spyOn(f.credentials, "save").mockImplementation((id, credential) => {
      expect(f.service.snapshot().entries).toMatchObject([{ kind: "pending", machineId: targetId, operation: "enroll" }])
      expect(f.registry.enrolled()).toEqual([])
      save(id, credential)
    })
    const result = await f.service.enroll(params)
    expect(result).toMatchObject({ outcome: "enrolled", machineId: targetId, fleet: { entries: [{ kind: "machine", machine: {
      ...descriptor, connection: "direct", self: false, verifiedRoute: { endpoint, lastAuthenticatedAt: new Date(1_000).toISOString() },
    } }] } })
    expect(f.credentials.forMachine(targetId)).toBe(token)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain(machineCredentialDigest(targetId, token))
    expect(f.changed).toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
  })

  it("does not spend a code when the keychain is unavailable", async () => {
    const f = fixture()
    f.keyring.get.mockImplementation(() => { throw new Error("locked") })
    expect(await f.service.enroll(params)).toEqual({ outcome: "refused", reason: "credential-store-unavailable" })
    expect(f.claim).not.toHaveBeenCalled()
  })

  it("retains a pending enrollment until restart repairs a failed keychain index write", async () => {
    const f = fixture()
    const write = f.keyring.set.getMockImplementation()!
    f.keyring.set.mockImplementation((id, value) => { if (id !== targetId) throw new Error("index locked"); write(id, value) })
    expect(await f.service.enroll(params)).toMatchObject({ outcome: "pending", operation: { operation: "enroll", machineId: targetId } })
    expect(f.registry.enrolled()).toEqual([])
    await f.service.stop()
    f.time(90_000)
    f.keyring.set.mockImplementation(write)
    const restarted = f.create()
    await restarted.reconcile()
    expect(restarted.snapshot().entries).toMatchObject([{ kind: "machine", machine: {
      heartbeat: { lastSeenAt: new Date(1_000).toISOString() },
    } }])
    expect(f.credentials.machines()).toEqual([targetId])
    expect(f.claim).toHaveBeenCalledTimes(1)
  })

  it("never promotes journal facts against different keychain bytes", async () => {
    const f = fixture()
    f.registry.stageEnrollment({ ...descriptor, connection: "direct", verifiedRoute: { endpoint, lastAuthenticatedAt: new Date(1_000).toISOString() } },
      machineCredentialDigest(targetId, token), 1_000)
    f.credentials.save(targetId, "z".repeat(43))
    await f.service.reconcile()
    expect(f.registry.enrolled()).toEqual([])
    expect(f.service.snapshot().entries).toEqual([{ kind: "unenrolled", machineId: targetId }])
    expect(f.credentials.forMachine(targetId)).toBe("z".repeat(43))
  })

  it("refreshes authenticated facts but never advances contact when authentication fails", async () => {
    const f = fixture()
    await f.service.enroll(params)
    f.time(20_000)
    f.call.mockResolvedValueOnce({ ...descriptor, label: "new studio", capabilities: ["sessions"] })
    await f.service.refresh()
    expect(f.service.snapshot().entries[0]).toMatchObject({ machine: {
      label: "new studio", capabilities: ["sessions"], heartbeat: { lastSeenAt: new Date(20_000).toISOString() },
    } })
    f.time(40_000)
    f.open.mockRejectedValueOnce(new MachinePairingRequiredError())
    await f.service.refresh()
    expect(f.service.snapshot().entries[0]).toMatchObject({ machine: {
      health: "pairing-required", heartbeat: { lastSeenAt: new Date(20_000).toISOString() },
    } })
  })

  it("does not turn keychain unavailability into a lost row or a false heartbeat", async () => {
    const f = fixture()
    await f.service.enroll(params)
    f.time(50_000)
    f.keyring.get.mockImplementation(() => { throw new Error("locked") })
    await f.service.refresh()
    expect(f.service.snapshot().entries[0]).toMatchObject({ machine: {
      health: "credential-store-unavailable", heartbeat: { lastSeenAt: new Date(1_000).toISOString() },
    } })
  })

  it("forgets only after revocation and durable keychain deletion, retaining pending work after deletion failure", async () => {
    const f = fixture()
    await f.service.enroll(params)
    const remove = f.keyring.delete.getMockImplementation()!
    f.keyring.delete.mockImplementation(() => { throw new Error("keychain locked") })
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toMatchObject({
      outcome: "pending", remoteRevocation: "confirmed", operation: { operation: "forget" },
    })
    expect(f.registry.enrolled()).toEqual([])
    expect(f.credentials.forMachine(targetId)).toBe(token)
    f.keyring.delete.mockImplementation(remove)
    await f.service.reconcile()
    expect(f.service.snapshot()).toEqual({ entries: [] })
    expect(f.credentials.forMachine(targetId)).toBeUndefined()
    expect(f.credentials.machines()).toEqual([])
  })

  it("reports unconfirmed remote revocation when an unreachable peer is forgotten locally", async () => {
    const f = fixture()
    await f.service.enroll(params)
    f.open.mockRejectedValue(new Error("network offline"))
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toEqual({
      outcome: "forgotten", machineId: targetId, remoteRevocation: "unconfirmed", fleet: { entries: [] },
    })
    expect(f.credentials.forMachine(targetId)).toBeUndefined()
  })

  it("shows and forgets an orphan key without fabricating target facts or remote revocation", async () => {
    const f = fixture()
    f.credentials.save(targetId, token)
    expect(f.service.snapshot()).toEqual({ entries: [{ kind: "unenrolled", machineId: targetId }] })
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toMatchObject({ outcome: "forgotten", remoteRevocation: "unconfirmed" })
    expect(f.open).not.toHaveBeenCalled()
  })

  it("does not resurrect a forgotten machine when its old heartbeat arrives late", async () => {
    const f = fixture()
    await f.service.enroll(params)
    let deliver: ((value: unknown) => void) | undefined
    f.call.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve }))
    const heartbeat = f.service.refresh()
    await vi.waitFor(() => expect(deliver).toBeDefined())
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toMatchObject({ outcome: "forgotten" })
    deliver!(descriptor)
    await heartbeat
    expect(f.service.snapshot()).toEqual({ entries: [] })
    expect(f.registry.enrolled()).toEqual([])
  })

  it("refuses overlapping enrollment claims without blocking other daemon work", async () => {
    const f = fixture()
    const response = { connection: { call: f.call, close: f.close }, credential: token, descriptor, endpoint }
    let deliver: ((value: typeof response) => void) | undefined
    f.claim.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve }))
    const first = f.service.enroll(params)
    await vi.waitFor(() => expect(deliver).toBeDefined())
    expect(await f.service.enroll({ ...params, endpoint: "wss://another-host/rpc" }))
      .toEqual({ outcome: "refused", reason: "operation-in-progress" })
    deliver!(response)
    expect(await first).toMatchObject({ outcome: "enrolled" })
  })
})
