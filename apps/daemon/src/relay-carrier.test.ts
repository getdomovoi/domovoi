import { createHash, generateKeyPairSync } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace, decodeRelayMultiplexedFrame, encodeRelayCarrierControl, encodeRelayMultiplexedFrame, parseRelayCarrierControl, type RelayCarrierControl } from "@getdomovoi/protocol"
import { relayPublicKeyFromPrivateKey, type RelayCarrier } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"

import { createDaemonRelayCarrier, loadDaemonRelayCarrierConfiguration, relayRegistrationBinding, type DaemonRelayCarrier, type DaemonRelayCarrierOptions, type DaemonRelayCarrierStatus } from "./relay-carrier.js"
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
  vi.restoreAllMocks()
})
async function fixture(onMessage: (socket: WebSocket, message: RelayCarrierControl) => void, host = "localhost", trust = true, respondPong = true,
  onStatus?: (status: DaemonRelayCarrierStatus) => void, policy: Partial<DaemonRelayCarrierOptions["policy"]> = {}) {
  const certificate = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), "utf8")
  const key = await readFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url))
  const server = createServer({ cert: certificate, key })
  const wss = new WebSocketServer({ server, maxPayload: 65539, autoPong: respondPong })
  const connections: WebSocket[] = []
  const records: RelayCarrierControl[] = []
  const frames: Array<{ socket: WebSocket; channelId: number; frame: Uint8Array }> = []
  wss.on("connection", (socket) => {
    connections.push(socket)
    socket.on("message", (bytes, binary) => {
      if (binary) { frames.push({ socket, ...decodeRelayMultiplexedFrame(bytes as Buffer) }); return }
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
      retryBaseMs: 10, retryMaximumMs: 20, heartbeatIntervalMs: respondPong ? 1000 : 20, heartbeatTimeoutMs: respondPong ? 1000 : 100,
      receiveWindowMs: 1000, maximumReceivedMessages: 32, maximumReceivedBytes: 131078,
      maximumChannels: 2, maximumQueuedBytes: 131078, maximumQueuedMessages: 8, ...policy },
  }
  const binding = relayRegistrationBinding(options, recovery.identity.machineId)
  await writeFile(options.generationPath, JSON.stringify({ version: 1, binding, generation: 0 }), { mode: 0o600 })
  const receive = vi.fn(), close = vi.fn()
  const openChannel = vi.fn((_options: { carrier: RelayCarrier }) => ({ receive, close, closed: false }))
  const carrier = createDaemonRelayCarrier(options, { recovery, openChannel, ...(onStatus ? { onStatus } : {}) })
  carriers.push(carrier)
  return { carrier, options, connections, records, frames, receive, close, openChannel }
}
const send = (socket: WebSocket, record: unknown) => socket.send(encodeRelayCarrierControl(record), { binary: false })
const acknowledge = (socket: WebSocket, record: RelayCarrierControl) => {
  if (record.kind === "register") send(socket, { kind: "registered", carrierVersion: 1, generation: record.generation })
}

// Keep one actual write in flight while subsequent frames enter the carrier's
// queue. The socket bytes are real; only its completion notification is held.
function holdFirstBinaryCompletion(serverSockets: WebSocket[]) {
  const original = WebSocket.prototype.send
  let held = false
  let release: (() => void) | undefined
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    const [data, options, callback] = args
    if (!held && !serverSockets.includes(this) && options?.binary) {
      held = true
      Reflect.apply(original, this, [data, options, (error?: Error) => { release = () => callback?.(error) }])
    } else Reflect.apply(original, this, args)
  })
  return async () => {
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 1000 })
    release!()
  }
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
  const realTimeout = setTimeout, realClearTimeout = clearTimeout
  async function io<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = realTimeout(() => reject(new Error("Half-open fixture I/O did not complete")), 2000)
      })])
    } finally { realClearTimeout(timer) }
  }
  const waiters: AbortController[] = []
  function event(socket: WebSocket, name: "ping" | "close") {
    const controller = new AbortController()
    waiters.push(controller)
    const outcome = io(once(socket, name, { signal: controller.signal })).finally(() => controller.abort())
    void outcome.catch(() => {}) // An earlier assertion may fail before this await.
    return outcome
  }
  let registered = () => {}, attempts = 0
  const f = await fixture(acknowledge, "localhost", true, false, (status) => {
    if (status.state === "registered") registered()
    if (status.state === "connecting") attempts++
  })
  const { heartbeatIntervalMs, heartbeatTimeoutMs, retryMaximumMs, maximumAttempts } = f.options.policy
  // Real TLS, generation persistence and Ping delivery have independent I/O
  // barriers. Only carrier timers advance here, never a wall-clock poll over
  // all retries; vi.waitFor would advance the fake clock implicitly.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      const acknowledged = new Promise<void>((resolve) => { registered = resolve })
      if (attempt === 1) await io(f.carrier.start())
      else {
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersToNextTimerAsync()
      }
      await io(acknowledged)
      expect(f.records).toHaveLength(attempt)
      const socket = f.connections[attempt - 1]!
      const probes = vi.fn()
      socket.on("ping", probes)
      const probe = event(socket, "ping")
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs - 1)
      expect(probes).not.toHaveBeenCalled()
      expect(f.carrier.status.state).toBe("registered")
      await vi.advanceTimersByTimeAsync(1)
      await probe
      expect(probes).toHaveBeenCalledOnce()
      expect(probes.mock.calls[0]![0]).toHaveLength(8)
      await vi.advanceTimersByTimeAsync(heartbeatTimeoutMs - 1)
      expect(f.carrier.status.state).toBe("registered")
      const closed = event(socket, "close")
      await vi.advanceTimersByTimeAsync(1)
      expect(f.carrier.status).toEqual(attempt < maximumAttempts
        ? { state: "retrying" } : { state: "refused", reason: "transport" })
      await closed
      expect(socket.readyState).toBe(WebSocket.CLOSED)
    }
    expect(f.records.map((record) => record.kind === "register" && record.generation)).toEqual([1, 2, 3])
    expect(JSON.parse(await io(readFile(f.options.generationPath, "utf8"))).generation).toBe(3)
    await vi.advanceTimersByTimeAsync(retryMaximumMs + heartbeatIntervalMs + heartbeatTimeoutMs)
    expect(f.carrier.status).toEqual({ state: "refused", reason: "transport" })
    expect(attempts).toBe(3)
    expect(f.records).toHaveLength(3)
    expect(f.connections).toHaveLength(3)
  } finally {
    for (const waiter of waiters) waiter.abort()
    try { await io(f.carrier.stop()) } finally { vi.useRealTimers() }
  }
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

it("drops a retired logical channel's queued bytes while retaining its in-flight boundary and another channel", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  for (const channelId of [1, 2]) send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledTimes(2), { timeout: 1000 })
  const a = f.openChannel.mock.calls[0]![0].carrier, b = f.openChannel.mock.calls[1]![0].carrier
  const release = holdFirstBinaryCompletion(f.connections)
  a.send(new Uint8Array([11])); a.send(new Uint8Array([12])); b.send(new Uint8Array([21]))
  await vi.waitFor(() => expect(f.frames.map((entry) => [...entry.frame])).toEqual([[11]]), { timeout: 1000 })
  a.close()
  await release()
  await vi.waitFor(() => expect(f.records.some((record) => record.kind === "close" && record.channelId === 1)).toBe(true), { timeout: 1000 })
  expect(f.frames.map(({ channelId, frame }) => [channelId, ...frame])).toEqual([[1, 11], [2, 21]])
  expect(f.close).toHaveBeenCalledOnce()
  b.send(new Uint8Array([22]))
  await vi.waitFor(() => expect(f.frames.at(-1)?.frame).toEqual(new Uint8Array([22])), { timeout: 1000 })
  await vi.waitFor(() => expect(b.bufferedAmount).toBe(0), { timeout: 1000 })
  expect(f.carrier.status.state).toBe("registered")
})

it("discards pending outbound frames across replacement and fences a stale logical handle and late callback", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const first = f.connections[0]!
  send(first, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  const old = f.openChannel.mock.calls[0]![0].carrier
  const release = holdFirstBinaryCompletion(f.connections)
  old.send(new Uint8Array([31])); old.send(new Uint8Array([32]))
  await vi.waitFor(() => expect(f.frames).toHaveLength(1), { timeout: 1000 })
  first.terminate()
  await vi.waitFor(() => { expect(f.connections).toHaveLength(2); expect(f.carrier.status.state).toBe("registered") }, { timeout: 1000 })
  send(f.connections[1]!, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledTimes(2), { timeout: 1000 })
  await release()
  old.send(new Uint8Array([33]))
  f.openChannel.mock.calls[1]![0].carrier.send(new Uint8Array([41]))
  await vi.waitFor(() => expect(f.frames.at(-1)?.frame).toEqual(new Uint8Array([41])), { timeout: 1000 })
  expect(f.frames.filter((entry) => entry.socket === first).map((entry) => [...entry.frame])).toEqual([[31]])
  expect(f.frames.filter((entry) => entry.socket !== first).map((entry) => [...entry.frame])).toEqual([[41]])
})

it("cannot schedule a retry after the status callback stops it", async () => {
  let stopping: Promise<void> | undefined
  const f = await fixture((socket, record) => { acknowledge(socket, record); socket.close(1012) }, "localhost", true, true,
    (status) => { if (status.state === "retrying") stopping = f.carrier.stop() })
  f.carrier.start()
  await vi.waitFor(() => expect(stopping).toBeDefined(), { timeout: 1000 })
  await stopping
  // A positive timer barrier is later than the configured maximum retry delay.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  expect(f.carrier.status.state).toBe("stopped")
  expect(f.records).toHaveLength(1)
})


it("answers server keepalive pings with matching bounded pongs", async () => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const pongs: Buffer[] = []
  f.connections[0]!.on("pong", (bytes) => pongs.push(bytes))
  f.connections[0]!.ping(Buffer.from("server-probe"))
  await vi.waitFor(() => expect(pongs).toEqual([Buffer.from("server-probe")]), { timeout: 1000 })
  expect(f.carrier.status.state).toBe("registered")
})

it("starts the response deadline only after a queued heartbeat is transmitted", async () => {
  const f = await fixture(acknowledge, "localhost", true, true, undefined,
    { heartbeatIntervalMs: 150, heartbeatTimeoutMs: 50, sendTimeoutMs: 1000 })
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const probes = vi.fn()
  f.connections[0]!.on("ping", probes)
  send(f.connections[0]!, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  const release = holdFirstBinaryCompletion(f.connections)
  f.openChannel.mock.calls[0]![0].carrier.send(new Uint8Array([1]))
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  expect(probes).not.toHaveBeenCalled()
  expect(f.connections).toHaveLength(1)
  expect(f.carrier.status.state).toBe("registered")
  await release()
  await vi.waitFor(() => expect(probes).toHaveBeenCalled(), { timeout: 1000 })
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  expect(f.carrier.status.state).toBe("registered")
})

it.each(["messages", "bytes"])("bounds aggregate inbound %s including discarded closed-channel frames", async (limit) => {
  const f = await fixture(acknowledge)
  f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const socket = f.connections[0]!
  send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
  send(socket, { kind: "close", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce(), { timeout: 1000 })
  for (let index = 0; index < (limit === "messages" ? 100 : 3); index++) {
    socket.send(encodeRelayMultiplexedFrame(1, new Uint8Array(limit === "messages" ? 1 : 65535)))
  }
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "capacity" }), { timeout: 1000 })
  expect(f.receive).not.toHaveBeenCalled()
})


it.each(["ping", "pong", "control"])("charges inbound %s traffic against the receive message budget", async (kind) => {
  const f = await fixture(acknowledge, "localhost", true, true, undefined, { maximumReceivedMessages: 8, maximumQueuedMessages: 64 })
  await f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const socket = f.connections[0]!
  send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  for (let index = 0; index < 9; index++) {
    if (kind === "ping") socket.ping(Buffer.alloc(0))
    else if (kind === "pong") socket.pong(Buffer.alloc(0))
    else send(socket, { kind: "close", carrierVersion: 1, channelId: 1 })
  }
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "capacity" }), { timeout: 1000 })
})

it("retains the receive budget across physical reconnection", async () => {
  const f = await fixture(acknowledge, "localhost", true, true, undefined,
    { maximumReceivedMessages: 5, receiveWindowMs: 10000, heartbeatIntervalMs: 10000 })
  await f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const first = f.connections[0]!
  send(first, { kind: "open", carrierVersion: 1, channelId: 1 })
  first.pong(Buffer.alloc(0)); first.pong(Buffer.alloc(0))
  send(first, { kind: "close", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce(), { timeout: 1000 })
  first.terminate()
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "capacity" }), { timeout: 1000 })
  expect(f.records).toHaveLength(2)
})

it("renews the receive allowance after its monotonic window", async () => {
  const f = await fixture(acknowledge, "localhost", true, true, undefined,
    { maximumReceivedMessages: 2, receiveWindowMs: 100, heartbeatIntervalMs: 10000 })
  await f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status.state).toBe("registered"), { timeout: 1000 })
  const socket = f.connections[0]!
  send(socket, { kind: "open", carrierVersion: 1, channelId: 1 })
  await vi.waitFor(() => expect(f.openChannel).toHaveBeenCalledOnce(), { timeout: 1000 })
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  socket.send(encodeRelayMultiplexedFrame(1, new Uint8Array([8])))
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledWith(new Uint8Array([8])), { timeout: 1000 })
  expect(f.carrier.status.state).toBe("registered")
})

it("accepts a matching Pong while the Ping completion callback is still pending", async () => {
  const f = await fixture(acknowledge, "localhost", true, true, undefined,
    { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 50, sendTimeoutMs: 1000 })
  const original = WebSocket.prototype.ping
  let release: (() => void) | undefined
  vi.spyOn(WebSocket.prototype, "ping").mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket["ping"]>) {
    const [bytes, mask, callback] = args
    if (!release && !f.connections.includes(this)) {
      Reflect.apply(original, this, [bytes, mask, (error: Error) => { release = () => callback?.(error) }])
    } else Reflect.apply(original, this, args)
  })
  await f.carrier.start()
  await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 1000 })
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  expect(f.carrier.status.state).toBe("registered")
  expect(f.connections).toHaveLength(1)
  release!()
})


it.each([
  "INVALID_CA", "PATH_LENGTH_EXCEEDED", "INVALID_PURPOSE", "UNABLE_TO_GET_CRL",
  "CRL_NOT_YET_VALID", "CRL_HAS_EXPIRED", "HOSTNAME_MISMATCH", "CRL_SIGNATURE_FAILURE",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD", "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
])("refuses certificate verification error %s after one durable reservation without retry", async (code) => {
  const f = await fixture(acknowledge, "localhost", false)
  const original = WebSocket.prototype.emit
  const failures = vi.fn()
  // Exercise a real rejected TLS handshake, varying only the library's error
  // code. No certificate bypass or synthetic successful upgrade is involved.
  vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
    if (event === "error" && !f.connections.includes(this) && args[0] instanceof Error) {
      failures()
      args[0] = Object.assign(new Error("Fixture certificate verification failure"), { code })
    }
    return Reflect.apply(original, this, [event, ...args])
  })
  await f.carrier.start()
  await vi.waitFor(() => expect(f.carrier.status).toEqual({ state: "refused", reason: "tls" }), { timeout: 1000 })
  // Later than the maximum retry delay: refusal must not reserve or dial again.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  expect(f.carrier.status).toEqual({ state: "refused", reason: "tls" })
  expect(failures).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(f.options.generationPath, "utf8")).generation).toBe(1)
  expect(f.records).toEqual([])
  expect(f.connections).toEqual([])
})
