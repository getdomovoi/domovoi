import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildVersion, createEmptyWorkspace, demoWorkspace, protocolVersion, relayClientPinSchema, rpcMethods, type RelayClientPin, type RelayIdentityPin, type RpcMethod, type RpcResult } from "@getdomovoi/protocol"
import { adoptRelayRecovery, createPinnedRelayClient, relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes, requireRelayPinRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { PairingCodeService } from "./pairing-codes.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "./production-daemon.js"
import { adoptRelayProfileSuccessor, prepareRelayProfileSuccessor } from "./relay-provisioning.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { productionRpcTimeoutMs, waitForDaemon } from "./test-wait-for.js"

const roots: string[] = [], sockets: WebSocket[] = [], stops: Array<() => Promise<void>> = [], databases: DatabaseSync[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  const settled = await Promise.allSettled(stops.splice(0).map((stop) => stop()))
  for (const database of databases.splice(0)) database.close()
  await removeScratchDirectories(roots)
  vi.restoreAllMocks()
  for (const result of settled) if (result.status === "rejected") throw result.reason
})

async function rpc(url: string, headers?: Record<string, string>) {
  const socket = new WebSocket(url, { headers, handshakeTimeout: productionRpcTimeoutMs(process.platform) })
  sockets.push(socket)
  const messages: Array<{ id?: number; result?: unknown; error?: { code: number; message: string } }> = []
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())))
  await once(socket, "open")
  let id = 0
  return { socket, async call<M extends RpcMethod>(method: M, params: unknown = {}) {
    const requestId = ++id
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    return waitForDaemon(() => {
      const response = messages.find((message) => message.id === requestId)
      if (!response) throw new Error("RPC response missing")
      return response as { result?: RpcResult<M>; error?: { code: number; message: string } }
    })
  } }
}

function signer() {
  const keys = generateKeyPairSync("ed25519")
  return { publicKey: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
    sign: (statement: Parameters<typeof relaySuccessorSigningBytes>[0]) => ({ statement, signature: sign(null, relaySuccessorSigningBytes(statement), keys.privateKey).toString("base64url") }) }
}

async function local(publication = true, beforeStart?: (daemon: DomovoiDaemon, identity: RelayIdentityPin) => void) {
  const key = randomBytes(32), identitySigner = signer()
  const identity: RelayIdentityPin = { version: 1, machineId: demoWorkspace.machine.id, identityPublicKey: identitySigner.publicKey,
    generation: 1, channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(key) } }
  const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace(demoWorkspace.machine))
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, relayStaticKey: key,
    ...(publication ? { relayRecovery: { identity } } : {}), providerProbe: { inspect: async () => [] }, errorSink: () => {} })
  key.fill(0)
  stops.push(() => daemon.stop())
  beforeStart?.(daemon, identity)
  const address = await daemon.start()
  return { daemon, store, identity, url: `ws://127.0.0.1:${address.port}/rpc` }
}

describe("public relay recovery query", () => {
  it("delivers public metadata before hello without granting workspace authority", async () => {
    const f = await local(), client = await rpc(f.url)
    const result = await client.call("relay.recovery", { machineId: f.identity.machineId })
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual({ identity: f.identity })
    expect((await client.call("workspace.get")).error?.message).toContain("authentication")
  })

  it("refuses foreign machines and bearer fields without disclosing a record", async () => {
    const f = await local(), client = await rpc(f.url)
    for (const params of [{ machineId: "machine-" + "f".repeat(32) }, { machineId: f.identity.machineId, authToken: f.daemon.authToken }]) {
      const response = await client.call("relay.recovery", params)
      expect(response.result).toBeUndefined()
      expect(response.error?.message).toBe("Relay recovery is unavailable")
    }
  })

  it("keeps the source quota across reconnects and ignores forwarding headers", async () => {
    const f = await local()
    for (let index = 0; index < 4; index++) {
      const client = await rpc(f.url, { "x-forwarded-for": `192.0.2.${index + 1}` })
      const response = await client.call("relay.recovery", { machineId: f.identity.machineId })
      expect(response.error !== undefined).toBe(index === 3)
      client.socket.terminate()
    }
  })

  it("counts malformed fetches against the quota before parameter validation", async () => {
    const f = await local(), client = await rpc(f.url)
    for (let index = 0; index < 3; index++) expect((await client.call("relay.recovery", {})).error?.message).toBe("Relay recovery is unavailable")
    expect((await client.call("relay.recovery", { machineId: f.identity.machineId })).result).toBeUndefined()
  })

  it("bounds all carrier sources together and refuses absent or oversized sources", async () => {
    const f = await local()
    const params = { machineId: f.identity.machineId }
    expect(() => f.daemon.relayRecovery(params, undefined)).toThrow("Relay recovery is unavailable")
    expect(() => f.daemon.relayRecovery(params, "x".repeat(257))).toThrow("Relay recovery is unavailable")
    for (let index = 0; index < 30; index++) expect(f.daemon.relayRecovery(params, `peer-${index}`).identity).toEqual(f.identity)
    expect(() => f.daemon.relayRecovery(params, "another-peer")).toThrow("Relay recovery is unavailable")
  })

  it("keeps returned publications and constructor inputs separate from served state", async () => {
    const f = await local(), expected = structuredClone(f.identity), params = { machineId: f.identity.machineId }
    f.identity.generation = 100
    const first = f.daemon.relayRecovery(params, "carrier-peer")
    first.identity.generation = 200
    expect(f.daemon.relayRecovery(params, "carrier-peer").identity).toEqual(expected)
  })

  it("refuses inconsistent or forged publications before opening profile state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-relay-publication-"))
    roots.push(directory)
    const statePath = join(directory, "state.sqlite"), key = randomBytes(32), otherKey = randomBytes(32), cold = signer()
    const identity: RelayIdentityPin = { version: 1, machineId: demoWorkspace.machine.id, identityPublicKey: cold.publicKey, generation: 1,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(key) } }
    const next = { ...identity, generation: 2 }
    const forged = { identity: next, successor: { statement: { ...next, previousChannelPublicKey: relayPublicKeyFromPrivateKey(otherKey) }, signature: Buffer.alloc(64).toString("base64url") } }
    try {
      for (const publication of [
        { identity: { ...identity, channel: { ...identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(otherKey) } } },
        { identity: { ...identity, identityPublicKey: Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64url") } },
        forged,
      ]) {
        expect(() => {
          const daemon = new DomovoiDaemon({ statePath, relayStaticKey: key, relayRecovery: publication, errorSink: () => {} })
          stops.push(() => daemon.stop())
        }).toThrow()
        expect(existsSync(statePath)).toBe(false)
      }
    } finally { key.fill(0); otherKey.fill(0) }
  })

  it("bounds a pre-admission frame before dispatch", async () => {
    const f = await local(), client = await rpc(f.url)
    let closeCode: number | undefined
    client.socket.on("close", (code) => { closeCode = code })
    const fetch = vi.spyOn(f.daemon, "relayRecovery")
    client.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "relay.recovery", params: { machineId: "x".repeat(32_768) } }))
    await waitForDaemon(() => expect(closeCode).toBe(1009))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("refuses opt-in enrollment before credential or claim side effects when only a warm key exists", async () => {
    const f = await local(false), client = await rpc(f.url)
    expect((await client.call("system.hello", { client: "cli", clientVersion: buildVersion, authToken: f.daemon.authToken, protocolVersion })).error).toBeUndefined()
    const code = await client.call("device.issueCode")
    const pair = vi.spyOn(f.store.devices, "pair"), claim = vi.spyOn(PairingCodeService.prototype, "claim")
    const input = { channelPublicKey: f.identity.channel.responderPublicKey, label: "phone" }
    expect((await client.call("device.pair", { ...input, client: "cli" })).result).toBeUndefined()
    expect((await client.call("device.claim", { ...input, code: code.result!.code, machineId: "machine-" + "c".repeat(32), protocolVersion })).result).toBeUndefined()
    expect(pair).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect((await client.call("relay.recovery", { machineId: f.identity.machineId })).result).toBeUndefined()
  })

  it("does not expose the publication before startup or after shutdown", async () => {
    const f = await local(true, (daemon, identity) => {
      expect(() => daemon.relayRecovery({ machineId: identity.machineId }, "carrier-peer")).toThrow("Relay recovery is unavailable")
    })
    expect(f.daemon.relayRecovery({ machineId: f.identity.machineId }, "carrier-peer")).toEqual({ identity: f.identity })
    await f.daemon.stop()
    expect(() => f.daemon.relayRecovery({ machineId: f.identity.machineId }, "carrier-peer")).toThrow("Relay recovery is unavailable")
  })
})

function pins(path: string, initial?: RelayClientPin): RelayPinStore {
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec("PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS pin (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)")
  const encoded = (pin: RelayClientPin) => JSON.stringify(relayClientPinSchema.parse(pin))
  if (initial) database.prepare("INSERT INTO pin VALUES (1, ?)").run(encoded(initial))
  return { read: async () => JSON.parse((database.prepare("SELECT record FROM pin WHERE id = 1").get() as { record: string }).record),
    compareAndSwap: async (expected, next) => database.prepare("UPDATE pin SET record = ? WHERE id = 1 AND record = ?").run(encoded(next), encoded(expected)).changes === 1 }
}

async function admitted(daemon: DomovoiDaemon, pin: RelayIdentityPin, store: RelayPinStore, token: string, key: Uint8Array) {
  const upstream: Uint8Array[] = [], downstream: Uint8Array[] = [], routeId = randomBytes(32).toString("base64url")
  const client = await createPinnedRelayClient(store, { machineId: pin.machineId, routeId, token, staticPrivateKey: key,
    carrier: { bufferedAmount: 0, send: (frame) => upstream.push(frame), close: () => {} }, onMessage: () => {} })
  let ingress: ReturnType<DomovoiDaemon["openRelayChannel"]> | undefined
  try {
    ingress = daemon.openRelayChannel({ context: { relayProtocol: 1, routeId, channel: pin.channel }, carrier: { bufferedAmount: 0, send: (frame) => downstream.push(frame), close: () => {} } })
    client.start()
    for (let count = 0; upstream.length + downstream.length; count++) {
      if (count > 16) throw new Error("Unbounded recovery handshake")
      const request = upstream.shift(), response = downstream.shift()
      if (request) ingress.receive(request)
      if (response) client.receive(response)
    }
    return client.admitted && !ingress.closed
  } finally { client.close(); ingress?.close() }
}

it.each([false, true])("delivers an offline client successor from a real rotated daemon (warm key lost: %s)", async (loseKey) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-relay-delivery-"))
  roots.push(homeDirectory)
  const identitySigner = signer(), key = randomBytes(32), credentialFile = join(homeDirectory, ".domovoi", "relay.key")
  const start = async (environment: Record<string, string> = {}) => {
    let daemon!: DomovoiDaemon
    const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0", ...environment }, errorSink: () => {} }, {
      ...productionDaemonDependencies, createProviderProbe: () => ({ inspect: async () => [] }), wslFacts: () => undefined,
      createDaemon(options) { daemon = new DomovoiDaemon(options); return daemon },
    })
    stops.push(() => handle.stop())
    return { daemon, handle, endpoint: await handle.start() }
  }
  try {
    const first = await start({ DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: identitySigner.publicKey, DOMOVOI_RELAY_CREDENTIAL_FILE: credentialFile })
    const enrollment = await rpc(first.endpoint.url)
    expect((await enrollment.call("system.hello", { client: "cli", clientVersion: buildVersion, authToken: first.handle.authToken, protocolVersion })).error).toBeUndefined()
    const response = await enrollment.call("device.pair", { client: "cli", targetClient: "phone", label: "offline phone", channelPublicKey: relayPublicKeyFromPrivateKey(key) })
    expect(response.error).toBeUndefined()
    const paired = rpcMethods["device.pair"].result.parse(response.result)
    const original = paired.relayIdentity!
    expect(original.identityPublicKey).toBe(identitySigner.publicKey)
    const pinPath = join(homeDirectory, "client-pin.sqlite")
    let store = pins(pinPath, { version: 1, state: "trusted", identity: original })
    expect(await admitted(first.daemon, original, store, paired.token, key)).toBe(true)
    await requireRelayPinRecovery(store)
    enrollment.socket.terminate()
    await first.handle.stop()
    if (loseKey) await unlink(credentialFile)
    const options = { homeDirectory, warn: () => {} }
    const statement = await prepareRelayProfileSuccessor(options)
    await adoptRelayProfileSuccessor(options, identitySigner.sign(statement))
    const second = await start()
    // The offline client gets neither the signer output nor the factory pin.
    // Only a fresh unauthenticated RPC delivers the successor it can adopt.
    const contact = await rpc(second.endpoint.url)
    const delivered = await contact.call("relay.recovery", { machineId: original.machineId })
    expect(delivered.error).toBeUndefined()
    store = pins(pinPath)
    await adoptRelayRecovery(store, delivered.result)
    const current = relayClientPinSchema.parse(await pins(pinPath).read())
    expect(current.identity.generation).toBe(2)
    expect(await admitted(second.daemon, current.identity, pins(pinPath), paired.token, key)).toBe(true)
    const stale = pins(join(homeDirectory, "stale-pin.sqlite"), { version: 1, state: "trusted", identity: original })
    expect(await admitted(second.daemon, current.identity, stale, paired.token, key)).toBe(false)
  } finally { key.fill(0) }
})
