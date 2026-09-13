import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { copyFile, mkdtemp, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createEmptyWorkspace, demoWorkspace, relayClientPinSchema, type RelayClientPin, type RelayIdentityPin } from "@getdomovoi/protocol"
import { adoptRelayPinSuccessor, createPinnedRelayClient, relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes, requireRelayPinRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it } from "vitest"

import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle } from "./production-daemon.js"
import { adoptRelayProfileSuccessor, prepareRelayProfileSuccessor } from "./relay-provisioning.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = []
const stops: Array<() => Promise<void>> = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  const settled = await Promise.allSettled(stops.splice(0).map((stop) => stop()))
  for (const database of databases.splice(0)) database.close()
  await removeScratchDirectories(roots)
  for (const result of settled) if (result.status === "rejected") throw result.reason
})

async function home(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `domovoi-${label}-`))
  roots.push(directory)
  return directory
}

function clientStore(path: string, initial?: RelayClientPin): RelayPinStore {
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec("PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS pin (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)")
  const encoded = (pin: RelayClientPin) => JSON.stringify(relayClientPinSchema.parse(pin))
  if (initial) database.prepare("INSERT INTO pin VALUES (1, ?)").run(encoded(initial))
  return {
    read: async () => JSON.parse((database.prepare("SELECT record FROM pin WHERE id = 1").get() as { record: string }).record),
    compareAndSwap: async (expected, next) => database.prepare("UPDATE pin SET record = ? WHERE id = 1 AND record = ?").run(encoded(next), encoded(expected)).changes === 1,
  }
}

async function production(homeDirectory: string, environment: Record<string, string>) {
  let daemon!: DomovoiDaemon, store!: SqliteWorkspaceStore
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0", ...environment }, errorSink: () => {} }, {
    ...productionDaemonDependencies, createProviderProbe: () => ({ inspect: async () => [] }), wslFacts: () => undefined,
    createDaemon(options) {
      store = new SqliteWorkspaceStore(options.statePath!, createEmptyWorkspace({ ...demoWorkspace.machine, ...options.machineIdentity }))
      daemon = new DomovoiDaemon({ ...options, store })
      return daemon
    },
  })
  stops.push(() => handle.stop())
  await handle.start()
  return { handle, daemon, store }
}

async function admitted(daemon: DomovoiDaemon, serverPin: RelayIdentityPin, pins: RelayPinStore, token: string, privateKey: Uint8Array): Promise<boolean> {
  const routeId = randomBytes(32).toString("base64url")
  const upstream: Uint8Array[] = [], downstream: Uint8Array[] = []
  const client = await createPinnedRelayClient(pins, {
    machineId: serverPin.machineId, routeId, token, staticPrivateKey: privateKey,
    carrier: { bufferedAmount: 0, send: (frame) => upstream.push(frame), close: () => {} }, onMessage: () => {},
  })
  let ingress: ReturnType<DomovoiDaemon["openRelayChannel"]> | undefined
  try {
    ingress = daemon.openRelayChannel({ context: { relayProtocol: 1, routeId, channel: serverPin.channel }, carrier: { bufferedAmount: 0, send: (frame) => downstream.push(frame), close: () => {} } })
    client.start()
    for (let exchanges = 0; upstream.length + downstream.length > 0; exchanges += 1) {
      if (exchanges > 16) throw new Error("Unbounded pin recovery handshake")
      const request = upstream.shift(), response = downstream.shift()
      if (request) ingress.receive(request)
      if (response) client.receive(response)
    }
    return client.admitted && !ingress.closed
  } finally { client.close(); ingress?.close() }
}

it.each([false, true])("recovers a persisted client pin through a real rotated daemon (warm key lost: %s)", async (loseKey) => {
  const homeDirectory = await home("relay-recovery-daemon")
  const clientDirectory = await home("relay-recovery-client")
  const signer = generateKeyPairSync("ed25519")
  const credentialFile = join(homeDirectory, ".domovoi", "relay.key")
  const publicIdentity = signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
  const first = await production(homeDirectory, { DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: credentialFile })
  const oldPin = first.handle.relayIdentity!
  const stolenKey = Buffer.from((JSON.parse(await readFile(credentialFile, "utf8")) as { privateKey: string }).privateKey, "base64url")
  const clientKey = randomBytes(32)
  try {
    const paired = first.store.devices.pair({ label: "recovery phone", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(clientKey) })
    const pinPath = join(clientDirectory, "pin.sqlite")
    let pins = clientStore(pinPath, { version: 1, state: "trusted", identity: oldPin })
    expect(await admitted(first.daemon, oldPin, pins, paired.token, clientKey)).toBe(true)
    await requireRelayPinRecovery(pins)
    // Reopen storage so refusal cannot depend on an in-memory distrust flag.
    pins = clientStore(pinPath)
    await expect(admitted(first.daemon, oldPin, pins, paired.token, clientKey)).rejects.toThrow("Relay pin recovery is required")
    await expect(prepareRelayProfileSuccessor({ homeDirectory, warn: () => {} })).rejects.toThrow("already owned")
    await first.handle.stop()
    const stolenDirectory = await home("relay-stolen-daemon")
    // The source store is closed. Copy the actual pairing ledger too, so the
    // old-key refusal cannot pass merely because this peer lacks the bearer.
    await copyFile(join(homeDirectory, ".domovoi", "state.sqlite"), join(stolenDirectory, "state.sqlite"))
    if (loseKey) await unlink(credentialFile)
    const options = { homeDirectory, warn: () => {} }
    const statement = await prepareRelayProfileSuccessor(options)
    const signed = { statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") }
    const next = await adoptRelayProfileSuccessor(options, signed)
    const second = await production(homeDirectory, {})
    expect(second.handle.relayIdentity).toEqual(next)
    await expect(admitted(second.daemon, next, pins, paired.token, clientKey)).rejects.toThrow("Relay pin recovery is required")
    await adoptRelayPinSuccessor(pins, signed)
    pins = clientStore(pinPath)
    expect(await admitted(second.daemon, next, pins, paired.token, clientKey)).toBe(true)
    const stalePins = clientStore(join(clientDirectory, "stale.sqlite"), { version: 1, state: "trusted", identity: oldPin })
    expect(await admitted(second.daemon, next, stalePins, paired.token, clientKey)).toBe(false)
    const stolenDaemon = new DomovoiDaemon({ host: "127.0.0.1", port: 0, authToken: randomBytes(32).toString("base64url"), relayStaticKey: stolenKey,
      store: new SqliteWorkspaceStore(join(stolenDirectory, "state.sqlite"), createEmptyWorkspace(demoWorkspace.machine)),
      providerProbe: { inspect: async () => [] }, errorSink: () => {},
    })
    stops.push(() => stolenDaemon.stop())
    await stolenDaemon.start()
    expect(await admitted(stolenDaemon, oldPin, stalePins, paired.token, clientKey)).toBe(true)
    expect(await admitted(stolenDaemon, oldPin, pins, paired.token, clientKey)).toBe(false)
    await second.handle.stop()
    const third: { handle: ProductionDaemonHandle; daemon: DomovoiDaemon } = await production(homeDirectory, {})
    expect(third.handle.relayIdentity).toEqual(next)
    expect(await admitted(third.daemon, next, clientStore(pinPath), paired.token, clientKey)).toBe(true)
  } finally { stolenKey.fill(0); clientKey.fill(0) }
})
