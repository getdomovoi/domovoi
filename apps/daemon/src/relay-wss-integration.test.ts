import { generateKeyPairSync } from "node:crypto"
import { once } from "node:events"
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { demoWorkspace, decodeRelayMultiplexedFrame, encodeRelayMultiplexedFrame, encodeRelayCarrierControl, parseRelayCarrierControl, protocolVersion, rpcMethods, type RelayRecoveryResult } from "@getdomovoi/protocol"
import { createPinnedRelayClient, relayPublicKeyFromPrivateKey } from "@getdomovoi/protocol/relay-admission"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { relayRegistrationBinding } from "./relay-carrier.js"
import { removeScratchDirectories } from "./test-scratch.js"

const routeId = Buffer.alloc(32, 9).toString("base64url"), registrationCredential = Buffer.alloc(32, 7).toString("base64url")
const serverKey = new Uint8Array(32).fill(12), clientKey = new Uint8Array(32).fill(11)
const roots: string[] = [], cleanups: Array<() => Promise<void>> = []
const wait = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 })
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), 5000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function cleanupFixtures(closers: Array<() => Promise<void>>, paths: string[]) {
  // A failed batch must never be reclaimed by a later test's successful stop.
  const batch = paths.splice(0)
  const failures: unknown[] = []
  for (const close of closers.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, `Fixture cleanup unconfirmed; retained scratch: ${batch.join(", ")}`)
  await removeScratchDirectories(batch)
}
afterEach(async () => { try { await cleanupFixtures(cleanups, roots) } finally { vi.restoreAllMocks() } })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-d4-wss-")); roots.push(directory)
  const ca = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), "utf8")
  const key = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url))
  const https = createServer({ cert: ca, key })
  const wss = new WebSocketServer({ server: https, maxPayload: 65539, perMessageDeflate: false })
  const sockets = new Set<WebSocket>(), clients = new Map<number, WebSocket>(), registrations: number[] = [], wire: Buffer[] = []
  const faults: unknown[] = []
  let publisher: WebSocket | undefined, publication: RelayRecoveryResult | undefined, nextChannel = 0, frames = 0
  let holdResponses = false, heldFrames = 0
  const control = (socket: WebSocket, record: unknown) => socket.send(encodeRelayCarrierControl(record), { binary: false })
  // This bounded, single-route fixture is not the production relay server.
  wss.on("connection", (socket) => {
    sockets.add(socket)
    let role: "greeting" | "publisher" | "client" = "greeting", channelId: number | undefined
    socket.on("error", (error) => faults.push(error))
    socket.on("message", (data, binary) => {
      try {
        if (++frames > 512) throw new Error("Fixture frame budget exhausted")
        const bytes = Buffer.from(data as Buffer); wire.push(bytes)
        if (binary) {
          if (role === "publisher") {
            const frame = decodeRelayMultiplexedFrame(bytes), target = clients.get(frame.channelId)
            if (holdResponses) { heldFrames++; return }
            if (target?.readyState === WebSocket.OPEN) target.send(frame.frame)
          } else if (role === "client" && publisher?.readyState === WebSocket.OPEN) publisher.send(encodeRelayMultiplexedFrame(channelId!, bytes))
          else throw new Error("Binary frame before route admission")
          return
        }
        const record = parseRelayCarrierControl(bytes)
        if (role === "greeting" && record.kind === "register") {
          expect(record.routeId).toBe(routeId); expect(record.registrationCredential).toBe(registrationCredential)
          expect(record.generation).toBeGreaterThan(registrations.at(-1) ?? 0)
          role = "publisher"; publisher = socket; publication = record.recovery; nextChannel = 0
          registrations.push(record.generation)
          control(socket, { kind: "registered", carrierVersion: 1, generation: record.generation })
        } else if (role === "greeting" && record.kind === "recover" && publication) {
          expect(record.routeId).toBe(routeId)
          control(socket, { kind: "recovery", carrierVersion: 1, recovery: publication })
        } else if (role === "greeting" && record.kind === "connect" && publisher?.readyState === WebSocket.OPEN) {
          expect(record.routeId).toBe(routeId)
          role = "client"; channelId = ++nextChannel; clients.set(channelId, socket)
          control(publisher, { kind: "open", carrierVersion: 1, channelId })
          control(socket, { kind: "connected", carrierVersion: 1 })
        } else if (role === "publisher" && record.kind === "close") clients.get(record.channelId)?.terminate()
        else throw new Error("Unexpected fixture control")
      } catch (error) { faults.push(error); socket.terminate() }
    })
    socket.on("close", () => {
      sockets.delete(socket)
      if (role === "publisher" && publisher === socket) { publisher = undefined; for (const client of clients.values()) client.terminate(); clients.clear() }
      if (role === "client" && clients.get(channelId!) === socket) {
        clients.delete(channelId!)
        if (publisher?.readyState === WebSocket.OPEN) control(publisher, { kind: "close", carrierVersion: 1, channelId })
      }
    })
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate()
    await bounded(new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : https.close((failure) => failure ? reject(failure) : resolve()))))
  })
  https.listen(0, "127.0.0.1"); await once(https, "listening", { signal: AbortSignal.timeout(5000) })
  const url = `wss://localhost:${(https.address() as { port: number }).port}/carrier`
  const snapshot = structuredClone(demoWorkspace)
  snapshot.project!.path = directory
  snapshot.approvals = []; snapshot.thread = []; snapshot.workingPlans = []
  snapshot.sessions = [snapshot.sessions[0]!]
  snapshot.activeSessionId = snapshot.sessions[0]!.id
  snapshot.sessions[0]!.state = "idle"
  delete snapshot.sessions[0]!.workspacePath; delete snapshot.sessions[0]!.providerThreadId; delete snapshot.sessions[0]!.activeTurnId
  snapshot.annotations = [snapshot.annotations[0]!]; snapshot.annotations[0]!.thread = []
  snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.id === snapshot.annotations[0]!.artifactId)
  const recovery: RelayRecoveryResult = { identity: { version: 1, machineId: snapshot.machine.id, generation: 1,
    identityPublicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(serverKey) } } }
  const config = { url, ca, routeId, registrationCredential, generationPath: join(directory, "generation.json"),
    policy: { connectTimeoutMs: 3000, registrationTimeoutMs: 3000, sendTimeoutMs: 3000, maximumAttempts: 3,
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000,
      receiveWindowMs: 1000, maximumReceivedMessages: 256, maximumReceivedBytes: 2_000_000,
      maximumChannels: 4, maximumQueuedBytes: 2_000_000, maximumQueuedMessages: 128 } }
  await writeFile(config.generationPath, JSON.stringify({ version: 1, binding: relayRegistrationBinding(config, snapshot.machine.id), generation: 0 }), { mode: 0o600 })
  const statePath = join(directory, "state.sqlite")
  let store = new SqliteWorkspaceStore(statePath, snapshot), daemon: DomovoiDaemon | undefined
  cleanups.push(async () => { if (daemon) await bounded(daemon.stop()); else await bounded(Promise.resolve(store.close())) })
  const paired = store.devices.pair({ label: "synthetic web", binding: { kind: "client", client: "web" }, channelPublicKey: relayPublicKeyFromPrivateKey(clientKey) })
  async function start() {
    daemon = new DomovoiDaemon({ host: "127.0.0.1", port: 0, statePath, profileDirectory: directory, store, agents: {},
      relayStaticKey: serverKey, relayRecovery: recovery, relayCarrier: config, errorSink: (context) => faults.push(context) })
    await bounded(daemon.start())
    await wait(() => { expect(faults).toEqual([]); expect(publisher?.readyState).toBe(WebSocket.OPEN) })
  }
  await start()
  async function physical() {
    const socket = new WebSocket(url, { ca, maxPayload: 65535, perMessageDeflate: false })
    cleanups.push(async () => { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, "close"); socket.terminate(); await bounded(closed) })
    await once(socket, "open", { signal: AbortSignal.timeout(5000) }); return socket
  }
  async function connect(privateKey = clientKey) {
    const recover = await physical()
    const response = once(recover, "message", { signal: AbortSignal.timeout(5000) })
    control(recover, { kind: "recover", carrierVersion: 1, routeId, machineId: snapshot.machine.id })
    const [data] = await response
    expect(parseRelayCarrierControl(data as Buffer)).toMatchObject({ kind: "recovery", recovery })
    const recoveryClosed = once(recover, "close"); recover.close(); await bounded(recoveryClosed)
    const socket = await physical(), messages: Array<{ id?: number; result?: unknown; error?: unknown }> = []
    let id = 0
    const client = await createPinnedRelayClient({ read: async () => ({ version: 1, state: "trusted", identity: recovery.identity }), compareAndSwap: async () => false }, {
      machineId: snapshot.machine.id, routeId, token: paired.token, staticPrivateKey: privateKey,
      carrier: { get bufferedAmount() { return socket.bufferedAmount }, send: (frame) => socket.send(frame), close: () => socket.terminate() },
      onMessage: (message) => messages.push(JSON.parse(message)),
    })
    socket.on("message", (bytes, binary) => {
      try {
        if (binary) client!.receive(new Uint8Array(bytes as Buffer))
        else { expect(parseRelayCarrierControl(bytes as Buffer).kind).toBe("connected"); client!.start() }
      } catch (error) { faults.push(error); socket.terminate() }
    })
    socket.on("close", () => client?.close())
    cleanups.push(async () => { client?.close() })
    control(socket, { kind: "connect", carrierVersion: 1, routeId })
    const rpc = async (method: string, params: object = {}) => {
      const requestId = ++id
      client!.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      await wait(() => { if (socket.readyState === WebSocket.CLOSED) throw new Error("Response lost on closed carrier"); expect(messages.some((message) => message.id === requestId)).toBe(true) })
      const reply = messages.find((message) => message.id === requestId)!
      expect(reply.error).toBeUndefined(); return reply.result
    }
    return { client, socket, messages, rpc, async admit() {
      await wait(() => expect(client!.admitted).toBe(true))
      const state = rpcMethods["system.hello"].result.parse(await rpc("system.hello", { client: "web", clientVersion: "0.0.1", protocolVersion }))
      expect(await rpc("device.current")).toMatchObject({ kind: "client", machineId: snapshot.machine.id, deviceId: paired.device.id, client: "web" })
      return state
    } }
  }
  return { connect, paired, registrations, wire, faults, annotationId: snapshot.annotations[0]!.id,
    get store() { return store }, get heldFrames() { return heldFrames }, hold() { holdResponses = true }, release() { holdResponses = false },
    async restart() { await bounded(daemon!.stop()); daemon = undefined; store = new SqliteWorkspaceStore(statePath, snapshot); await start() },
  }
}

it("retains one committed mutation across WSS reply loss, fresh admission and a closed/reopened SQLite daemon", async () => {
  const f = await fixture(), first = await f.connect()
  await first.admit()
  f.hold()
  const lost = first.rpc("annotation.reply", { annotationId: f.annotationId, body: "durable synthetic mutation", client: "web" }).catch((error: unknown) => error)
  await wait(() => expect(f.store.load().annotations[0]!.thread).toHaveLength(1))
  await wait(() => expect(f.heldFrames).toBeGreaterThan(0))
  first.socket.terminate()
  expect(await lost).toMatchObject({ message: "Response lost on closed carrier" })
  f.release()
  const second = await f.connect(), refreshed = await second.admit()
  expect(refreshed.annotations[0]!.thread).toHaveLength(1)
  const replyId = refreshed.annotations[0]!.thread[0]!.id
  await f.restart()
  const third = await f.connect(), restarted = await third.admit()
  expect(restarted.annotations[0]!.thread.map((reply) => reply.id)).toEqual([replyId])
  expect(f.store.devices.verify(f.paired.token)?.channelPublicKey).toBe(relayPublicKeyFromPrivateKey(clientKey))
  expect(f.registrations).toEqual([1, 2])
  const audit = await f.store.auditLog.query({ action: "annotation.reply" })
  expect(audit.entries.filter((entry) => entry.outcome === "succeeded")).toHaveLength(1)
  expect(f.wire.some((frame) => frame.includes(Buffer.from(f.paired.token)))).toBe(false)
  expect(f.wire.some((frame) => frame.includes(Buffer.from("durable synthetic mutation")))).toBe(false)
  expect(f.faults).toEqual([])
}, 20_000)

it("rejects a different static key for the same paired bearer before RPC admission", async () => {
  const f = await fixture(), wrong = await f.connect(new Uint8Array(32).fill(14))
  await wait(() => expect(wrong.client.closed).toBe(true))
  expect(wrong.client.admitted).toBe(false)
  expect(wrong.messages).toEqual([])
  expect(f.store.load().annotations[0]!.thread).toEqual([])
  expect(f.faults).toEqual([])
}, 15_000)

it("never lets a later successful teardown delete an unconfirmed fixture root", async () => {
  const first = await mkdtemp(join(tmpdir(), "domovoi-d4-retained-"))
  const second = await mkdtemp(join(tmpdir(), "domovoi-d4-next-"))
  const paths = [first]
  const closers: Array<() => Promise<void>> = [async () => { throw new Error("synthetic unconfirmed stop") }]
  try {
    await expect(cleanupFixtures(closers, paths)).rejects.toThrow("cleanup unconfirmed")
    paths.push(second); closers.push(async () => {})
    await cleanupFixtures(closers, paths)
    await expect(access(first)).resolves.toBeUndefined()
    await expect(access(second)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    // This fault is synthetic: no writer or process was started for either path.
    await removeScratchDirectories([first, second])
  }
})
