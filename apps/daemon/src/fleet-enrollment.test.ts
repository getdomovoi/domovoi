import { waitForDaemon } from "./test-wait-for.js"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"
import { maximumFleetMachines, protocolVersion, type FleetMachineDescriptor } from "@getdomovoi/protocol"

import { FleetEnrollmentService } from "./fleet-enrollment.js"
import { SqliteFleetRegistry } from "./fleet-registry.js"
import { MachineCredentialStore, machineCredentialDigest } from "./machine-credentials.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { MachinePairingRequiredError, MachineProtocolMismatchError, type openMachineSocket } from "./machine-socket.js"

function release(minorOffset: number) {
  const [major, minor] = protocolVersion.split(".").map(Number)
  return `${major}.${minor! + minorOffset}.0`
}

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
  const asyncCredentials = asyncTestCredentials(credentials)
  const call = vi.fn(async (method: string): Promise<unknown> => method === "device.revokeCurrent" ? { revoked: true } : descriptor)
  const close = vi.fn()
  const open = vi.fn<typeof openMachineSocket>(async () => ({ call, close }))
  const claim = vi.fn(async () => ({ connection: { call, close }, credential: token, descriptor, endpoint }))
  const changed = vi.fn()
  let now = 1_000
  const create = (sshTunnels: Array<{ machineId: string; endpoint: string }> = []) => {
    const routes = { sshTunnels }
    const service = new FleetEnrollmentService({
      selfId: sourceId, registry, credentials: asyncCredentials, claim, open, changed, ...routes,
      now: () => now, operationTimeoutMs: 1_000, heartbeatIntervalMs: 15_000,
    })
    services.push(service)
    return service
  }
  return { service: create(), create, registry, database, credentials, asyncCredentials, values, keyring, claim, open, call, close, changed, time: (value: number) => { now = value } }
}

describe("fleet enrollment coordinator", () => {
  it("uses SSH for heartbeat and forget without turning a removable forward into a remembered route", async () => {
    const f = fixture()
    await f.service.enroll(params)
    await f.service.stop()
    const forward = "ws://127.0.0.1:47900/rpc"
    const configured = f.create([{ machineId: targetId, endpoint: forward }])
    f.open.mockImplementation(async (input) => {
      if (input.endpoint !== forward) throw new Error("direct endpoint is down")
      return { call: f.call, close: f.close }
    })
    f.time(20_000)
    await configured.refresh()
    expect(configured.snapshot().entries[0]).toMatchObject({ machine: {
      health: "healthy", heartbeat: { lastSeenAt: new Date(20_000).toISOString() },
      verifiedRoute: { endpoint, lastAuthenticatedAt: new Date(1_000).toISOString() },
      transports: [],
    } })
    expect(JSON.stringify(configured.snapshot())).not.toContain(forward)
    await configured.stop()

    const removed = f.create()
    f.open.mockClear()
    f.time(40_000)
    await removed.refresh()
    expect(removed.snapshot().entries[0]).toMatchObject({ machine: {
      health: "reconnecting", heartbeat: { lastSeenAt: new Date(20_000).toISOString() },
    } })
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ endpoint }))
    await removed.stop()

    const restored = f.create([{ machineId: targetId, endpoint: forward }])
    expect(await restored.forget({ machineId: targetId, client: "cli" })).toMatchObject({
      outcome: "forgotten", remoteRevocation: "confirmed",
    })
    expect(f.call).toHaveBeenCalledWith("device.revokeCurrent", {}, undefined, expect.anything())
  })

  it("refreshes an enrolled machine over SSH when no direct route was ever stored", async () => {
    const f = fixture()
    await f.service.enroll(params)
    await f.service.stop()
    // A row written before this daemon stored verified routes keeps its
    // credential but has no source-verified direct endpoint to preserve.
    f.database.prepare("UPDATE fleet_machines SET verified_route = NULL, connection = 'lan' WHERE id = ?").run(targetId)
    expect(f.registry.enrolled()[0]?.facts.verifiedRoute).toBeUndefined()
    const forward = "ws://127.0.0.1:47900/rpc"
    const configured = f.create([{ machineId: targetId, endpoint: forward }])
    const refresh = vi.spyOn(f.registry, "refreshAuthenticated")
    f.open.mockImplementation(async (input) => {
      if (input.endpoint !== forward) throw new Error("direct endpoint is down")
      return { call: f.call, close: f.close }
    })
    f.time(20_000)
    await configured.refresh()
    expect(refresh).toHaveReturnedWith(true)
    const [entry] = configured.snapshot().entries
    expect(entry).toMatchObject({ machine: {
      health: "healthy", connection: "ssh", heartbeat: { lastSeenAt: new Date(20_000).toISOString() },
    } })
    expect(entry?.kind === "machine" && "verifiedRoute" in entry.machine).toBe(false)
    expect(JSON.stringify(configured.snapshot())).not.toContain(forward)
  })

  it("renders a snapshot without reading the keychain again after a successful mutation", async () => {
    const f = fixture()
    expect(await f.service.enroll(params)).toMatchObject({ outcome: "enrolled" })
    const reads = vi.spyOn(f.asyncCredentials, "machines").mockRejectedValue(new Error("native locked"))
    expect(f.service.snapshot().entries).toMatchObject([{ kind: "machine" }])
    expect(reads).not.toHaveBeenCalled()
    expect(f.call.mock.calls.filter(([method]) => method === "device.revokeCurrent")).toEqual([])
  })

  it("does not resurrect orphan metadata from an older list after forget completed", async () => {
    const f = fixture()
    f.credentials.save(targetId, token)
    await f.service.list()
    let release: (value: string[]) => void = () => {}
    vi.spyOn(f.asyncCredentials, "machines").mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const oldList = f.service.list()
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toMatchObject({ outcome: "forgotten" })
    release([targetId])
    expect(await oldList).toEqual({ entries: [] })
    expect(f.service.snapshot()).toEqual({ entries: [] })
  })

  it("does not publish a late keyring result after shutdown", async () => {
    const f = fixture()
    let release: (value: string[]) => void = () => {}
    vi.spyOn(f.asyncCredentials, "machines").mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const listing = expect(f.service.list()).rejects.toThrow("keychain is unavailable")
    const stopping = f.service.stop()
    release([targetId])
    await listing
    await stopping
    expect(f.service.snapshot()).toEqual({ entries: [] })
    expect(f.changed).not.toHaveBeenCalled()
  })

  it("does not replace a newer healthy observation with an older index failure", async () => {
    const f = fixture()
    await f.service.enroll(params)
    let reject: (error: Error) => void = () => {}
    vi.spyOn(f.asyncCredentials, "machines").mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure }))
    const oldList = f.service.list()
    await f.service.refresh()
    expect(f.service.snapshot().entries[0]).toMatchObject({ machine: { health: "healthy" } })
    reject(new Error("earlier native attempt failed"))
    expect((await oldList).entries[0]).toMatchObject({ machine: { health: "healthy" } })
  })

  it("requires a known expected identity to re-pair at capacity without spending an ambiguous claim", async () => {
    const f = fixture()
    for (let index = 0; index < maximumFleetMachines; index++) {
      f.registry.record({
        ...descriptor, id: index === 0 ? targetId : `machine-${index.toString(16).padStart(32, "0")}`,
        connection: "direct", verifiedRoute: { endpoint, lastAuthenticatedAt: new Date(1_000).toISOString() },
      }, 1_000)
    }
    expect(await f.service.enroll(params)).toEqual({ outcome: "refused", reason: "fleet-limit" })
    expect(f.claim).not.toHaveBeenCalled()
    expect(await f.service.enroll({ ...params, expectedMachineId: targetId })).toMatchObject({
      outcome: "enrolled", machineId: targetId,
    })
    expect(f.claim).toHaveBeenCalledOnce()
    expect(f.claim).toHaveBeenCalledWith(expect.objectContaining({ expectedMachineId: targetId }))
    expect(f.service.snapshot().entries).toHaveLength(maximumFleetMachines)
  })

  it("does not count legacy recovery rows as admitted machines and can forget one beyond admission capacity", async () => {
    const f = fixture()
    const orphans = Array.from({ length: 129 }, (_, index) => `machine-${index.toString(16).padStart(32, "0")}`)
    for (const id of orphans) f.credentials.save(id, token)
    expect(await f.service.enroll(params)).toMatchObject({ outcome: "enrolled", machineId: targetId })
    expect(f.service.snapshot().entries).toHaveLength(130)
    expect(await f.service.forget({ machineId: orphans[0]!, client: "cli" })).toMatchObject({
      outcome: "forgotten", remoteRevocation: "unconfirmed",
    })
    expect(f.credentials.forMachine(orphans[0]!)).toBeUndefined()
    expect(f.service.snapshot().entries).toHaveLength(129)
    expect(f.registry.enrolled()).toHaveLength(1)
  })

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
    expect((await f.service.list()).entries).toEqual([{ kind: "unenrolled", machineId: targetId }])
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

  it.each([
    ["names an older release", release(-1), protocolVersion, "upgrade-required"],
    ["names a newer release", release(1), protocolVersion, "version-mismatch"],
    ["names nothing and the peer last advertised an older release", undefined, release(-1), "upgrade-required"],
    ["names nothing and the peer last advertised this release", undefined, protocolVersion, "version-mismatch"],
  ])("grades a protocol refusal that %s", async (_case, refusedVersion, lastAdvertised, health) => {
    const f = fixture()
    await f.service.enroll(params)
    // A row this daemon's previous release wrote keeps the version the peer
    // advertised to it then.
    f.database.prepare("UPDATE fleet_machines SET protocol_version = ? WHERE id = ?").run(lastAdvertised, targetId)
    f.open.mockRejectedValueOnce(new MachineProtocolMismatchError(refusedVersion))
    await f.service.refresh()
    expect(f.service.snapshot().entries[0]).toMatchObject({ machine: { health, protocolVersion: lastAdvertised } })
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
    expect(await f.service.list()).toEqual({ entries: [{ kind: "unenrolled", machineId: targetId }] })
    expect(await f.service.forget({ machineId: targetId, client: "cli" })).toMatchObject({ outcome: "forgotten", remoteRevocation: "unconfirmed" })
    expect(f.open).not.toHaveBeenCalled()
  })

  it("does not resurrect a forgotten machine when its old heartbeat arrives late", async () => {
    const f = fixture()
    await f.service.enroll(params)
    let deliver: ((value: unknown) => void) | undefined
    f.call.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve }))
    const heartbeat = f.service.refresh()
    await waitForDaemon(() => expect(deliver).toBeDefined())
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
    await waitForDaemon(() => expect(deliver).toBeDefined())
    expect(await f.service.enroll({ ...params, endpoint: "wss://another-host/rpc" }))
      .toEqual({ outcome: "refused", reason: "operation-in-progress" })
    deliver!(response)
    expect(await first).toMatchObject({ outcome: "enrolled" })
  })
})
