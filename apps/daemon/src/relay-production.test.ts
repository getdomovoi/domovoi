import { createPrivateKey, createPublicKey } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, demoWorkspace, decodeRelayMultiplexedFrame, encodeRelayCarrierControl, encodeRelayMultiplexedFrame, parseRelayCarrierControl, protocolVersion } from "@getdomovoi/protocol"
import { createRelayClient, relayPublicKeyFromPrivateKey } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"

import { OperationDeadline } from "./operation-deadline.js"
import { claimProfile } from "./profile-lease.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle, type ProductionDaemonRuntime } from "./production-daemon.js"
import { loadOrProvisionRelayChannel, relayProvisioningPath, type ProvisionedRelayChannel } from "./relay-provisioning.js"
import { DomovoiDaemon, type DaemonServerOptions } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { relayRegistrationBinding } from "./relay-carrier.js"

const publicIdentity = createPublicKey(createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8" }))
  .export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
const roots: string[] = []
const handles: ProductionDaemonHandle[] = []
const connections: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
  for (const close of connections.splice(0)) await close()
  await removeScratchDirectories(roots)
})
const runtime = (options: DaemonServerOptions): ProductionDaemonRuntime => ({
  host: "127.0.0.1", requestedPort: 0, authToken: options.authToken!,
  start: async () => ({ host: "127.0.0.1", port: 0 }), stop: async () => {},
})
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-relay-production-"))
  roots.push(directory)
  return directory
}

it("passes a real persisted channel key into the production server across restarts and wipes the factory copy", async () => {
  const homeDirectory = await home()
  const credentialFile = join(homeDirectory, ".domovoi", "relay.key")
  const seen: string[] = []
  const copies: Uint8Array[] = []
  const createDaemon = vi.fn((options: DaemonServerOptions) => {
    expect(options.relayStaticKey).toBeDefined()
    seen.push(relayPublicKeyFromPrivateKey(options.relayStaticKey!))
    copies.push(options.relayStaticKey!)
    return runtime(options)
  })
  const first = await createProductionDaemonWithDependencies({
    homeDirectory, environment: { DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: credentialFile }, errorSink: () => {},
  }, { ...productionDaemonDependencies, createDaemon })
  handles.push(first)
  expect(first.relayIdentity?.channel.responderPublicKey).toBe(seen[0])
  expect(copies[0]).toEqual(new Uint8Array(32))
  await first.stop()
  const second = await createProductionDaemonWithDependencies({ homeDirectory, environment: {}, errorSink: () => {} }, { ...productionDaemonDependencies, createDaemon })
  handles.push(second)
  expect(second.relayIdentity).toEqual(first.relayIdentity)
  expect(seen[1]).toBe(seen[0])
  const credential = JSON.parse(await readFile(credentialFile, "utf8")) as { privateKey: string }
  expect(relayPublicKeyFromPrivateKey(Buffer.from(credential.privateKey, "base64url"))).toBe(seen[0])
  await second.stop()
  await unlink(credentialFile)
  await expect(createProductionDaemonWithDependencies({ homeDirectory, environment: {}, errorSink: () => {} }, { ...productionDaemonDependencies, createDaemon })).rejects.toThrow("missing")
  expect(createDaemon).toHaveBeenCalledTimes(2)
})

it("holds the profile lease while a cancelled key publication settles, then wipes its late result", async () => {
  const homeDirectory = await home()
  const cancel = new AbortController()
  const deadline = OperationDeadline.start(30_000, { signal: cancel.signal })
  let finish!: (value: ProvisionedRelayChannel) => void
  const pending = new Promise<ProvisionedRelayChannel>((resolve) => { finish = resolve })
  const createDaemon = vi.fn(runtime)
  const loading = vi.fn(() => { cancel.abort(); return pending })
  await expect(createProductionDaemonWithDependencies({ homeDirectory, environment: {}, errorSink: () => {} }, {
    ...productionDaemonDependencies, loadRelayChannel: loading, createDaemon,
  }, { lease: claimProfile(homeDirectory), deadline }).then((handle) => { handles.push(handle); return "started" })).rejects.toThrow("cancelled")
  expect(loading).toHaveBeenCalledOnce()
  expect(createDaemon).not.toHaveBeenCalled()
  expect(() => claimProfile(homeDirectory)).toThrow()
  const lateKey = new Uint8Array(32).fill(7)
  finish({ privateKey: lateKey, identity: { version: 1, machineId: "machine-" + "a".repeat(32), identityPublicKey: publicIdentity, generation: 1, channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(lateKey) } } })
  await pending
  await new Promise((resolve) => setImmediate(resolve))
  expect(lateKey).toEqual(new Uint8Array(32))
  const next = claimProfile(homeDirectory)
  next.release()
  deadline.clear()
})

it("admits a paired client through a real daemon using the provisioned channel key", async () => {
  const homeDirectory = await home()
  let daemon!: DomovoiDaemon
  let store!: SqliteWorkspaceStore
  const handle = await createProductionDaemonWithDependencies({
    homeDirectory, errorSink: () => {},
    environment: { DOMOVOI_PORT: "0", DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: join(homeDirectory, ".domovoi", "relay.key") },
  }, {
    ...productionDaemonDependencies,
    createProviderProbe: () => ({ inspect: async () => [] }), wslFacts: () => undefined,
    createDaemon(options) {
      store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({ ...demoWorkspace.machine, ...options.machineIdentity }))
      daemon = new DomovoiDaemon({ ...options, store })
      return daemon
    },
  })
  handles.push(handle)
  await handle.start()
  const clientKey = new Uint8Array(32).fill(11)
  const paired = store.devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(clientKey) })
  const context = { relayProtocol: 1 as const, routeId: Buffer.alloc(32, 9).toString("base64url"), channel: handle.relayIdentity!.channel }
  const upstream: Uint8Array[] = [], downstream: Uint8Array[] = []
  const ingress = daemon.openRelayChannel({ context, carrier: { bufferedAmount: 0, send: (frame) => downstream.push(frame), close: () => {} } })
  expect(ingress).toBeDefined()
  const client = createRelayClient({ context, token: paired.token, staticPrivateKey: clientKey, carrier: { bufferedAmount: 0, send: (frame) => upstream.push(frame), close: () => {} }, onMessage: () => {} })
  try {
    client.start()
    for (let exchanges = 0; upstream.length + downstream.length > 0; exchanges += 1) {
      if (exchanges > 16) throw new Error("Unbounded provisioning handshake")
      const request = upstream.shift(), response = downstream.shift()
      if (request) ingress!.receive(request)
      if (response) client.receive(response)
    }
    expect(client.admitted).toBe(true)
    expect(ingress!.closed).toBe(false)
  } finally { client.close(); ingress?.close(); clientKey.fill(0) }
})

it("stops provisioning before late secret writes when the deadline expires during a keychain probe", async () => {
  const homeDirectory = await home()
  const cancel = new AbortController()
  const deadline = OperationDeadline.start(30_000, { signal: cancel.signal })
  const get = vi.fn(), set = vi.fn(), generateKey = vi.fn()
  await expect(loadOrProvisionRelayChannel({ homeDirectory, machineId: "machine-" + "a".repeat(32), identityPublicKey: publicIdentity, deadline, warn: () => {} }, {
    keyring: { available: async () => { cancel.abort(); return true }, get, set, delete: vi.fn() },
    generateKey, publishRecord: vi.fn(),
  })).rejects.toThrow("cancelled")
  expect(get).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  expect(generateKey).not.toHaveBeenCalled()
  await expect(readFile(relayProvisioningPath(homeDirectory))).rejects.toMatchObject({ code: "ENOENT" })
  deadline.clear()
})

it("loads explicit profile registration in the production factory and serves paired RPC through real WSS and Noise admission", async () => {
  const homeDirectory = await home()
  const profile = join(homeDirectory, ".domovoi")
  await mkdir(profile, { mode: 0o700 })
  const ca = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), "utf8")
  const key = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url))
  const server = createServer({ cert: ca, key })
  const wss = new WebSocketServer({ server, maxPayload: 65539 })
  connections.push(async () => { for (const peer of wss.clients) peer.terminate(); await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve()))) })
  let peer: WebSocket | undefined
  let publication: unknown
  let client: ReturnType<typeof createRelayClient> | undefined
  const wire: Uint8Array[] = []
  wss.on("connection", (socket) => {
    peer = socket
    socket.on("message", (bytes, binary) => {
      if (binary) { wire.push(Buffer.from(bytes as Buffer)); client?.receive(decodeRelayMultiplexedFrame(bytes as Buffer).frame); return }
      const record = parseRelayCarrierControl(bytes as Buffer)
      if (record.kind === "register") {
        publication = record.recovery
        socket.send(encodeRelayCarrierControl({ kind: "registered", carrierVersion: 1, generation: record.generation }), { binary: false })
      }
    })
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const config = { version: 1, url: `wss://localhost:${(server.address() as { port: number }).port}/carrier`, ca,
    routeId: Buffer.alloc(32, 9).toString("base64url"), registrationCredential: Buffer.alloc(32, 7).toString("base64url"),
    policy: { connectTimeoutMs: 1000, registrationTimeoutMs: 1000, sendTimeoutMs: 1000, maximumAttempts: 2,
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000,
      maximumChannels: 2, maximumQueuedBytes: 131078, maximumQueuedMessages: 16 } }
  await writeFile(join(profile, "relay-carrier.json"), JSON.stringify(config), { mode: 0o600 })
  let store!: SqliteWorkspaceStore
  let daemon!: DomovoiDaemon
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, errorSink: () => {},
    environment: { DOMOVOI_PORT: "0", DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: join(profile, "relay.key") },
  }, { ...productionDaemonDependencies, createProviderProbe: () => ({ inspect: async () => [] }), wslFacts: () => undefined,
    createDaemon(options) {
      store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({ ...demoWorkspace.machine, ...options.machineIdentity }))
      daemon = new DomovoiDaemon({ ...options, store }); return daemon
    } })
  handles.push(handle)
  await writeFile(join(profile, "relay-generation.json"), JSON.stringify({ version: 1,
    binding: relayRegistrationBinding(config, handle.relayIdentity!.machineId), generation: 0 }), { mode: 0o600 })
  await handle.start()
  await vi.waitFor(() => expect(publication).toEqual({ identity: handle.relayIdentity }), { timeout: 2000 })
  const clientKey = new Uint8Array(32).fill(11)
  const paired = store.devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(clientKey) })
  const messages: Array<{ id?: number; result?: unknown }> = []
  client = createRelayClient({ context: { relayProtocol: 1, routeId: config.routeId, channel: handle.relayIdentity!.channel },
    token: paired.token, staticPrivateKey: clientKey, carrier: { bufferedAmount: 0,
      send: (frame) => { wire.push(frame.slice()); peer!.send(encodeRelayMultiplexedFrame(1, frame)) }, close: () => {} },
    onMessage: (message) => messages.push(JSON.parse(message)) })
  try {
    peer!.send(encodeRelayCarrierControl({ kind: "open", carrierVersion: 1, channelId: 1 }), { binary: false })
    client.start()
    await vi.waitFor(() => expect(client!.admitted).toBe(true), { timeout: 2000 })
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: { client: "phone", clientVersion: "0.0.1", protocolVersion } }))
    await vi.waitFor(() => expect(messages.find((message) => message.id === 1)).toHaveProperty("result"), { timeout: 2000 })
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace.get", params: {} }))
    await vi.waitFor(() => expect(messages.find((message) => message.id === 2)).toHaveProperty("result"), { timeout: 2000 })
    expect(wire.some((frame) => Buffer.from(frame).includes(Buffer.from(paired.token)))).toBe(false)
    await handle.stop()
    expect(daemon.address).toBeUndefined()
  } finally { client.close(); client = undefined; clientKey.fill(0) }
})

it.each(["missing", "malformed"])("closes the production listener and releases ownership when generation state is %s", async (state) => {
  const homeDirectory = await home()
  const profile = join(homeDirectory, ".domovoi")
  await mkdir(profile, { mode: 0o700 })
  await writeFile(join(profile, "relay-carrier.json"), JSON.stringify({ version: 1, url: "wss://localhost:1/carrier",
    routeId: Buffer.alloc(32, 9).toString("base64url"), registrationCredential: Buffer.alloc(32, 7).toString("base64url"),
    policy: { connectTimeoutMs: 1000, registrationTimeoutMs: 1000, sendTimeoutMs: 1000, maximumAttempts: 2,
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000,
      maximumChannels: 2, maximumQueuedBytes: 131078, maximumQueuedMessages: 16 } }), { mode: 0o600 })
  if (state === "malformed") await writeFile(join(profile, "relay-generation.json"), "{}", { mode: 0o600 })
  let daemon!: DomovoiDaemon
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, errorSink: () => {},
    environment: { DOMOVOI_PORT: "0", DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: join(profile, "relay.key") },
  }, { ...productionDaemonDependencies, createProviderProbe: () => ({ inspect: async () => [] }), wslFacts: () => undefined,
    createDaemon(options) {
      const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({ ...demoWorkspace.machine, ...options.machineIdentity }))
      daemon = new DomovoiDaemon({ ...options, store }); return daemon
    } })
  handles.push(handle)
  await expect(handle.start()).rejects.toThrow("generation state")
  await vi.waitFor(() => {
    expect(daemon.address).toBeUndefined()
    const lease = claimProfile(homeDirectory)
    lease.release()
  }, { timeout: 2000 })
})

it.each(["client", "machine"] as const)("refuses a persisted %s bearer as the registration credential before connecting", async (kind) => {
  const homeDirectory = await home()
  const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace(demoWorkspace.machine))
  const paired = store.devices.pair({ label: "existing authority", binding: kind === "client"
    ? { kind: "client", client: "phone" } : { kind: "machine", machineId: "machine-" + "c".repeat(32) } })
  const key = new Uint8Array(32).fill(12)
  const recovery = { identity: { version: 1 as const, machineId: demoWorkspace.machine.id, identityPublicKey: publicIdentity, generation: 1,
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(key) } } }
  const relayCarrier = { url: "wss://localhost:1/carrier", routeId: Buffer.alloc(32, 9).toString("base64url"), registrationCredential: paired.token,
    generationPath: join(homeDirectory, "relay-generation.json"),
    policy: { connectTimeoutMs: 1000, registrationTimeoutMs: 1000, sendTimeoutMs: 1000, maximumAttempts: 2,
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000,
      maximumChannels: 2, maximumQueuedBytes: 131078, maximumQueuedMessages: 16 } }
  await writeFile(relayCarrier.generationPath, JSON.stringify({ version: 1, binding: relayRegistrationBinding(relayCarrier, demoWorkspace.machine.id), generation: 0 }), { mode: 0o600 })
  const daemon = new DomovoiDaemon({ port: 0, store, relayStaticKey: key, relayRecovery: recovery, relayCarrier, errorSink: () => {} })
  try { await expect(daemon.start()).rejects.toThrow("registration credential") }
  finally { await daemon.stop(); key.fill(0) }
  expect(JSON.parse(await readFile(relayCarrier.generationPath, "utf8")).generation).toBe(0)
})
