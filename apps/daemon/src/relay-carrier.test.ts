import { createHash, generateKeyPairSync } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace, encodeRelayCarrierControl, encodeRelayMultiplexedFrame, parseRelayCarrierControl, type RelayCarrierControl } from "@getdomovoi/protocol"
import { relayPublicKeyFromPrivateKey, type RelayCarrier } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"

import { createDaemonRelayCarrier, loadDaemonRelayCarrierConfiguration, relayRegistrationBinding, type DaemonRelayCarrier, type DaemonRelayCarrierOptions } from "./relay-carrier.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = [], cleanups: Array<() => Promise<void>> = []
const carriers: DaemonRelayCarrier[] = []
const routeId = Buffer.alloc(32, 9).toString("base64url")
const credential = Buffer.alloc(32, 7).toString("base64url")
const recovery = { identity: { version: 1 as const, machineId: demoWorkspace.machine.id, generation: 1,
  identityPublicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
  channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(new Uint8Array(32).fill(12)) } } }
afterEach(async () => {
  await Promise.all(carriers.splice(0).map((carrier) => carrier.stop()))
  for (const close of cleanups.splice(0)) await close()
  await removeScratchDirectories(roots)
})
async function fixture(onMessage: (socket: WebSocket, message: RelayCarrierControl) => void, host = "localhost", trust = true, respondPong = true) {
  const certificate = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), "utf8")
  const key = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url))
  const server = createServer({ cert: certificate, key })
  const wss = new WebSocketServer({ server, maxPayload: 65539, autoPong: respondPong })
  const connections: WebSocket[] = []
  const records: RelayCarrierControl[] = []
  wss.on("connection", (socket) => {
    connections.push(socket)
    socket.on("message", (bytes, binary) => {
      if (binary) return
      const message = parseRelayCarrierControl(Buffer.from(bytes as Buffer))
      records.push(message)
      onMessage(socket, message)
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(async () => { for (const socket of connections) socket.terminate(); await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve()))) })
  const directory = await mkdtemp(join(tmpdir(), "domovoi-relay-carrier-"))
  roots.push(directory)
  const options: DaemonRelayCarrierOptions = {
    url: `wss://${host}:${(server.address() as { port: number }).port}/carrier`, routeId, registrationCredential: credential,
    generationPath: join(directory, "relay-generation.json"), ...(trust ? { ca: certificate } : {}),
    policy: { connectTimeoutMs: 500, registrationTimeoutMs: 500, sendTimeoutMs: 500, maximumAttempts: 3,
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100,
      maximumChannels: 2, maximumQueuedBytes: 131078, maximumQueuedMessages: 8 },
  }
  const binding = relayRegistrationBinding(options, recovery.identity.machineId)
  await writeFile(options.generationPath, JSON.stringify({ version: 1, binding, generation: 0 }), { mode: 0o600 })
  const receive = vi.fn(), close = vi.fn()
  const openChannel = vi.fn((_options: { carrier: RelayCarrier }) => ({ receive, close, closed: false }))
  const carrier = createDaemonRelayCarrier(options, { recovery, openChannel })
  carriers.push(carrier)
  return { carrier, options, connections, records, receive, close, openChannel }
}
const send = (socket: WebSocket, record: unknown) => socket.send(encodeRelayCarrierControl(record), { binary: false })
const acknowledge = (socket: WebSocket, record: RelayCarrierControl) => {
  if (record.kind === "register") send(socket, { kind: "registered", carrierVersion: 1, generation: record.generation })
}

it("registers only after valid TLS, publishes the bound recovery and routes opaque frames to admission", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 2000 })
  expect(f.records[0]).toMatchObject({ kind: "register", routeId, registrationCredential: credential, generation: 1, recovery })
  send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId: 1 })
  f.connections[0]!.send(encodeRelayMultiplexedFrame(1, new Uint8Array([3, 4])))
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledWith(new Uint8Array([3, 4])), { timeout: 1000 })
  expect(f.openChannel).toHaveBeenCalledOnce()
  expect(f.openChannel.mock.calls[0]).toMatchObject([{ context: { routeId, channel: recovery.identity.channel, relayProtocol: 1 } }])
})

it.each([["127.0.0.1", true], ["localhost", false]] as const)("sends no registration through invalid TLS %s/%s", async (host, trust) => {
  const f = await fixture(acknowledge, host, trust)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toMatchObject({ state: "refused", reason: "tls" }), { timeout: 2000 })
  expect(f.records).toEqual([])
  expect(f.connections).toEqual([])
})

it("treats an unacknowledged secure registration as action required, without diagnosing its hidden cause", async () => {
  const f = await fixture((socket) => socket.terminate())
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toMatchObject({ state: "refused", reason: "registration" }), { timeout: 1000 })
  expect(f.records).toHaveLength(1)
})

it("reconnects with a durable newer generation, closes old channels and never replays frames", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  f.connections[0]!.terminate()
  await vi.waitFor(() => expect(f.records).toHaveLength(2), { timeout: 2000 })
  expect(f.records.map((record) => record.kind === "register" && record.generation)).toEqual([1, 2])
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.receive).not.toHaveBeenCalled()
  await f.carrier.stop()
  expect(f.carrier.status.state).toBe("stopped")
})

it("drops a closed channel's late frame but refuses a never-issued identifier", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const socket = f.connections[0]!
  send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
  send(socket, { kind: "close", carrierVersion: 1, channelId: 1 })
  socket.send(encodeRelayMultiplexedFrame(1, new Uint8Array([1])))
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce(), { timeout: 1000 })
  expect(f.receive).not.toHaveBeenCalled()
  expect(f.carrier.status.state).toBe("registered")
  socket.send(encodeRelayMultiplexedFrame(2, new Uint8Array([1])))
  await vi.waitFor(() => expect(f.carrier.status).toMatchObject({ state: "refused", reason: "protocol" }), { timeout: 1000 })
})

it("binds generations to endpoint, route, machine and independent credential without storing the credential", () => {
  const options = { url: "wss://relay.example/carrier", routeId, registrationCredential: credential }
  const binding = relayRegistrationBinding(options, recovery.identity.machineId)
  expect(binding).toMatch(/^[a-f0-9]{64}$/)
  expect(binding).not.toBe(createHash("sha256").update(credential).digest("hex"))
  for (const changed of [{ ...options, url: "wss://other.example/carrier" }, { ...options, routeId: credential }, { ...options, registrationCredential: routeId }]) {
    expect(relayRegistrationBinding(changed, recovery.identity.machineId)).not.toBe(binding)
  }
  expect(relayRegistrationBinding(options, "machine-" + "b".repeat(32))).not.toBe(binding)
})

it.each(["wrong-generation", "binary-first", "oversized-control", "duplicate-channel"])("refuses %s instead of reconnecting", async (failure) => {
  const f = await fixture((socket, record) => {
    if (record.kind !== "register") return
    if (failure === "wrong-generation") send(socket, { kind: "registered", carrierVersion: 1, generation: record.generation + 1 })
    if (failure === "binary-first") socket.send(encodeRelayMultiplexedFrame(1, new Uint8Array([1])))
    if (failure === "oversized-control") socket.send(" ".repeat(4097))
    if (failure === "duplicate-channel") {
      acknowledge(socket, record)
      send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
      send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
    }
  })
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toMatchObject({ state: "refused", reason: "protocol" }), { timeout: 1000 })
  expect(f.connections).toHaveLength(1)
})

it("bounds total reconnect attempts and never resurrects a stopped carrier", async () => {
  const f = await fixture((socket, record) => { acknowledge(socket, record); socket.close(1012) })
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toMatchObject({ state: "refused", reason: "transport" }), { timeout: 2000 })
  expect(f.records).toHaveLength(3)
  await f.carrier.stop()
  f.carrier.start()
  expect(f.carrier.status.state).toBe("stopped")
})

it("bounds the send queue including the in-flight message and closes every admitted channel on overflow", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  const logical = f.openChannel.mock.calls[0]![0].carrier
  for (let index = 0; index < 9; index++) logical.send(new Uint8Array([1]))
  expect(f.carrier.status).toEqual({ state: "refused", reason: "capacity" })
  expect(f.close).toHaveBeenCalledOnce()
})

it("refuses excess logical channels", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  for (let channelId = 1; channelId <= 3; channelId++) send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId })
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "capacity" }), { timeout: 1000 })
  expect(f.openChannel).toHaveBeenCalledTimes(2)
  expect(f.close).toHaveBeenCalledTimes(2)
})

it("expires registration without sending endpoint traffic", async () => {
  const f = await fixture(() => {})
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "registration" }), { timeout: 2000 })
  expect(f.openChannel).not.toHaveBeenCalled()
  expect(f.records).toHaveLength(1)
})

it("detects a silent half-open connection through bounded ping/pong probes", async () => {
  const f = await fixture(acknowledge, "localhost", true, false)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "transport" }), { timeout: 2000 })
  expect(f.records).toHaveLength(3)
})

it("retires immediately closed admission without consuming a channel slot", async () => {
  const f = await fixture(acknowledge)
  f.openChannel.mockReturnValue({ receive: f.receive, close: f.close, closed: true })
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  for (let channelId = 1; channelId <= 3; channelId++) send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId })
  await vi.waitFor(() => expect(f.records.filter((record) => record.kind === "close")).toHaveLength(3), { timeout: 1000 })
  expect(f.carrier.status.state).toBe("registered")
})

it("loads only bounded private operator configuration and never exposes malformed contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-relay-config-"))
  roots.push(directory)
  const path = join(directory, "relay-carrier.json")
  expect(loadDaemonRelayCarrierConfiguration(directory)).toBeUndefined()
  await writeFile(path, JSON.stringify({ registrationCredential: credential }), { mode: 0o600 })
  expect(() => loadDaemonRelayCarrierConfiguration(directory)).toThrow("configuration is invalid")
  try { loadDaemonRelayCarrierConfiguration(directory) } catch (error) { expect(String(error)).not.toContain(credential) }
  await writeFile(path, "x".repeat(65537))
  expect(() => loadDaemonRelayCarrierConfiguration(directory)).toThrow("private bounded regular file")
})
