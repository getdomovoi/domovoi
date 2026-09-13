import { createPrivateKey, createPublicKey } from "node:crypto"
import { mkdtemp, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, demoWorkspace } from "@getdomovoi/protocol"
import { createRelayClient, relayPublicKeyFromPrivateKey } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it, vi } from "vitest"

import { OperationDeadline } from "./operation-deadline.js"
import { claimProfile } from "./profile-lease.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle, type ProductionDaemonRuntime } from "./production-daemon.js"
import { loadOrProvisionRelayChannel, relayProvisioningPath, type ProvisionedRelayChannel } from "./relay-provisioning.js"
import { DomovoiDaemon, type DaemonServerOptions } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const publicIdentity = createPublicKey(createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8" }))
  .export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
const roots: string[] = []
const handles: ProductionDaemonHandle[] = []
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
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
