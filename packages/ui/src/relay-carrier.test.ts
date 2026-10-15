import { afterEach, expect, it, vi } from "vitest"
import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { createRelayResponder, relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes, type RelayChannel, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"
import { demoWorkspace, encodeRelayCarrierControl, rpcMethods, type RelayClientPin } from "@getdomovoi/protocol"
import { DomovoiClient } from "./client.js"
import { createRelaySocket, type RelayWebSocket, type RelaySocketOptions } from "./relay-carrier.js"
import { Deadline } from "./deadline.js"

const machineId = `machine-${"a".repeat(32)}`
const routeId = Buffer.alloc(32, 9).toString("base64url")
const clientKey = new Uint8Array(32).fill(11), serverKey = new Uint8Array(32).fill(12)
const token = "paired_".padEnd(43, "x")
const identityKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 8)]), format: "der", type: "pkcs8" })
const identityPublicKey = createPublicKey(identityKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
const pin: RelayClientPin = { version: 1, state: "trusted", identity: { version: 1, machineId, identityPublicKey, generation: 1,
  channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(serverKey) } } }
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

class Wire extends EventTarget implements RelayWebSocket {
  readyState = 0
  bufferedAmount = 0
  binaryType: BinaryType = "blob"
  sent: (string | Uint8Array)[] = []
  onSend: ((data: string | Uint8Array) => void) | undefined
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const value = typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)
    this.sent.push(value)
    this.onSend?.(value)
  }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")) }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })) }
  control(value: unknown) { this.receive(new TextDecoder().decode(encodeRelayCarrierControl(value))) }
  lost(code = 1006, reason = "") { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason })) }
}

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(overrides: { pinStore?: RelayPinStore; key?: Uint8Array; token?: string; limits?: RelaySocketOptions["limits"]; now?: () => number; deadlineMs?: number } = {}) {
  const wires: Wire[] = []
  const deadline = Deadline.start(overrides.deadlineMs ?? 5_000)
  const store: RelayPinStore = overrides.pinStore ?? { read: async () => structuredClone(pin), compareAndSwap: async () => true }
  const socket = createRelaySocket({ endpoint: "wss://relay.example/carrier", machineId, routeId,
    token: overrides.token ?? token, staticPrivateKey: overrides.key ?? clientKey, pinStore: store, deadline,
    limits: overrides.limits ?? { windowMs: 1_000, maximumMessagesPerWindow: 100, maximumBytesPerWindow: 1_000_000 },
    ...(overrides.now ? { now: overrides.now } : {}),
    createWebSocket() { const wire = new Wire(); wires.push(wire); return wire } })
  const opened = vi.fn(), messages: unknown[] = [], closed: number[] = []
  socket.addEventListener("open", opened)
  socket.addEventListener("message", (event) => messages.push(event.data))
  socket.addEventListener("close", (event) => closed.push(event.code))
  cleanup.push(() => { socket.close(); deadline.clear() })
  async function connect() {
    await vi.waitFor(() => expect(wires).toHaveLength(1))
    wires[0]!.open()
    expect(JSON.parse(wires[0]!.sent[0] as string).kind).toBe("recover")
    wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
    await vi.waitFor(() => expect(wires).toHaveLength(2))
    const wire = wires[1]!
    wire.open()
    expect(JSON.parse(wire.sent[0] as string).kind).toBe("connect")
    wire.control({ kind: "connected", carrierVersion: 1 })
    await flush()
    return wire
  }
  return { socket, wires, opened, messages, closed, connect, deadline }
}
function responder(wire: Wire, accept = true) {
  const received: string[] = []
  const replies: Uint8Array[] = []
  const server: RelayChannel = createRelayResponder({ context: { relayProtocol: 1, routeId, channel: pin.identity.channel }, staticPrivateKey: serverKey,
    authorize: (value, key) => accept && value === token && Buffer.from(key).toString("base64url") === relayPublicKeyFromPrivateKey(clientKey),
    carrier: { bufferedAmount: 0, send: (frame) => replies.push(frame.slice()), close() { wire.lost(1006) } }, onMessage: (message) => received.push(message) })
  cleanup.push(() => server.close())
  return { server, received, replies, step() {
    const frame = wire.sent.findLast((value) => value instanceof Uint8Array)
    expect(frame).toBeInstanceOf(Uint8Array)
    server.receive(frame as Uint8Array)
    const reply = replies.shift()
    if (reply) wire.receive(reply.slice().buffer)
  } }
}

it("opens only after real pinned Noise admission and encrypts both credential and application bytes", async () => {
  const f = fixture(), wire = await f.connect(), remote = responder(wire)
  expect(f.opened).not.toHaveBeenCalled()
  expect(wire.sent[1]).toHaveLength(96)
  remote.step()
  expect(f.opened).not.toHaveBeenCalled()
  remote.step()
  expect(f.opened).toHaveBeenCalledTimes(1)
  expect(f.socket.readyState).toBe(1)
  const message = JSON.stringify({ method: "workspace.get", id: 1 })
  f.socket.send(message); remote.step()
  expect(remote.received).toEqual([message])
  remote.server.send("reply")
  wire.receive(remote.replies.shift()!.buffer)
  expect(f.messages).toEqual(["reply"])
  for (const raw of wire.sent) {
    const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw)
    expect(bytes.includes(Buffer.from(token))).toBe(false)
    expect(bytes.includes(Buffer.from(message))).toBe(false)
  }
})

it.each([undefined, { ...pin, identity: { ...pin.identity, machineId: `machine-${"b".repeat(32)}` } }])("refuses an absent or foreign saved pin before any socket", async (saved) => {
  const f = fixture({ pinStore: { read: async () => saved, compareAndSwap: async () => true } })
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.wires).toEqual([])
})

it("closes a pending saved-pin read without dialing when its result arrives late", async () => {
  let resolve!: (value: unknown) => void
  const f = fixture({ pinStore: { read: () => new Promise((done) => { resolve = done }), compareAndSwap: async () => true } })
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); f.socket.close(); resolve(pin); await flush()
  expect(f.wires).toEqual([])
  expect(f.socket.readyState).toBe(3)
})

it("does not queue an application mutation before admission or replay it on another socket", async () => {
  const f = fixture()
  expect(() => f.socket.send("mutation")).toThrow()
  expect(f.wires).toEqual([])
  f.socket.close(); await flush()
  expect(f.socket.readyState).toBe(3)
  expect(f.opened).not.toHaveBeenCalled()
})

it.each(["handshake", "receipt"])("keeps an ordinary network loss during %s retryable", async (stage) => {
  const f = fixture(), wire = await f.connect()
  if (stage === "receipt") responder(wire).step()
  wire.lost(1006)
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.wires).toHaveLength(2)
})

it("preserves actual policy refusal and invalid encrypted input as terminal", async () => {
  const f = fixture(), wire = await f.connect()
  wire.lost(1008)
  expect(f.closed).toEqual([1008])
  const g = fixture(), other = await g.connect()
  other.receive(new Uint8Array(48).buffer)
  expect(g.closed).toEqual([1008])
  expect(g.opened).not.toHaveBeenCalled()
})

it.each(["oversize", "binary", "wrong-control"])("bounds and refuses %s during recovery", async (kind) => {
  const f = fixture()
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  const wire = f.wires[0]!
  wire.open()
  if (kind === "oversize") wire.receive("x".repeat(4097))
  else if (kind === "binary") wire.receive(new Uint8Array(8).buffer)
  else wire.control({ kind: "connected", carrierVersion: 1 })
  expect(f.closed).toEqual([1008])
  expect(wire.readyState).toBe(3)
  expect(f.wires).toHaveLength(1)
})

it("refuses an oversized frame or unexpected text after connection", async () => {
  const f = fixture(), wire = await f.connect()
  wire.receive(new Uint8Array(65_536).buffer)
  expect(f.closed).toEqual([1008])
  const g = fixture(), other = await g.connect()
  other.control({ kind: "connected", carrierVersion: 1 })
  expect(g.closed).toEqual([1008])
})

it("bounds the real physical bufferedAmount before each encrypted send", async () => {
  const f = fixture(), wire = await f.connect(), remote = responder(wire)
  remote.step(); remote.step()
  const sent = wire.sent.length
  wire.bufferedAmount = Number.MAX_SAFE_INTEGER
  expect(() => f.socket.send("mutation")).toThrow()
  expect(wire.sent).toHaveLength(sent)
  expect(f.closed).toEqual([1008])
  expect(remote.received).toEqual([])
})

it("ignores late messages after close and uses fresh Noise state on the next attempt", async () => {
  const f = fixture(), wire = await f.connect(), remote = responder(wire)
  const first = wire.sent[1]
  f.socket.close()
  remote.step()
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.messages).toEqual([])
  const g = fixture(), other = await g.connect()
  expect(other.sent[1]).not.toEqual(first)
})

it("shares the caller deadline with a stalled pin read and ignores its late result", async () => {
  vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  const f = fixture({ pinStore: { read: () => new Promise((done) => { resolve = done }), compareAndSwap: async () => true } })
  await flush()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  resolve(pin); await flush()
  expect(f.wires).toEqual([])
  expect(f.opened).not.toHaveBeenCalled()
})

it.each(["messages", "bytes"])("enforces the caller's inbound %s budget before admission", async (kind) => {
  const f = fixture({ limits: { windowMs: 1_000, maximumMessagesPerWindow: kind === "messages" ? 1 : 100,
    maximumBytesPerWindow: kind === "bytes" ? 1 : 1_000_000 } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
  if (kind === "messages") {
    await vi.waitFor(() => expect(f.wires).toHaveLength(2))
    f.wires[1]!.open()
    f.wires[1]!.control({ kind: "connected", carrierVersion: 1 })
    expect(f.wires[1]!.sent).toHaveLength(1)
  }
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.opened).not.toHaveBeenCalled()
})

it("refuses backward clock continuity rather than resetting the inbound budget", async () => {
  let at = 100
  const f = fixture({ now: () => at })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open(); at = 99
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.wires).toHaveLength(1)
})

function successor() {
  const channel = { ...pin.identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(new Uint8Array(32).fill(13)) }
  const statement = { version: 1 as const, machineId, identityPublicKey, generation: 2, previousChannelPublicKey: pin.identity.channel.responderPublicKey, channel }
  return { identity: { ...pin.identity, generation: 2, channel }, successor: { statement,
    signature: sign(null, relaySuccessorSigningBytes(statement), identityKey).toString("base64url") } }
}

it("persists a signed successor against the saved predecessor before creating a fresh channel", async () => {
  let saved: RelayClientPin = { ...pin, state: "recovery-required" }
  const swap = vi.fn(async (expected, replacement) => { expect(expected).toEqual(saved); saved = replacement; return true })
  const f = fixture({ pinStore: { read: async () => structuredClone(saved), compareAndSwap: swap } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  const publication = successor()
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: publication })
  await vi.waitFor(() => expect(f.wires).toHaveLength(2))
  expect(saved).toEqual({ version: 1, state: "trusted", identity: publication.identity })
  expect(swap).toHaveBeenCalledTimes(1)
  expect(f.wires[0]!.readyState).toBe(3)
  expect(f.opened).not.toHaveBeenCalled()
})

it.each(["missing", "forged", "cas-refused"])("refuses %s recovery without opening a Noise socket", async (kind) => {
  const saved = { ...pin, state: "recovery-required" as const }
  const swap = vi.fn(async () => false)
  const f = fixture({ pinStore: { read: async () => saved, compareAndSwap: swap } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  const publication = successor()
  if (kind === "forged") publication.successor.signature = Buffer.alloc(64, 1).toString("base64url")
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: kind === "missing" ? { identity: pin.identity } : publication })
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.wires).toHaveLength(1)
  expect(swap).toHaveBeenCalledTimes(kind === "cas-refused" ? 1 : 0)
})

it("does not dial after a valid recovery persistence operation completes following close", async () => {
  let complete!: (saved: boolean) => void
  const swap = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve }))
  const f = fixture({ pinStore: { read: async () => ({ ...pin, state: "recovery-required" }), compareAndSwap: swap } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: successor() })
  await vi.waitFor(() => expect(swap).toHaveBeenCalledTimes(1))
  f.socket.close(); complete(true); await flush()
  expect(f.wires).toHaveLength(1)
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.closed).toEqual([1000])
})

it.each([0, -1, NaN, Infinity, 2_147_483_648])("refuses invalid window %s before any network effect", async (windowMs) => {
  const f = fixture({ limits: { windowMs, maximumMessagesPerWindow: 1, maximumBytesPerWindow: 1_000 } })
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.wires).toEqual([])
})

it("the channel's uncompleted admission deadline remains a retryable loss", async () => {
  vi.useFakeTimers()
  const f = fixture({ deadlineMs: 20_000 }), wire = await f.connect()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  expect(wire.readyState).toBe(3)
  expect(f.opened).not.toHaveBeenCalled()
})

it("replenishes the inbound budget only after the monotonic window boundary", async () => {
  let at = 100
  const f = fixture({ now: () => at, limits: { windowMs: 1_000, maximumMessagesPerWindow: 1, maximumBytesPerWindow: 1_000_000 } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(2))
  at = 1_100
  const wire = f.wires[1]!
  wire.open(); wire.control({ kind: "connected", carrierVersion: 1 })
  expect(wire.sent[1]).toHaveLength(96)
  expect(f.closed).toEqual([])
})

it("copies but never erases the caller's enrolled private key", async () => {
  const key = clientKey.slice()
  const f = fixture({ key })
  key.fill(99)
  const wire = await f.connect(), remote = responder(wire)
  remote.step(); remote.step()
  expect(f.opened).toHaveBeenCalledTimes(1)
  f.socket.close()
  expect(key).toEqual(new Uint8Array(32).fill(99))
})

it("keeps a physical send exception during the Noise handshake retryable", async () => {
  const f = fixture()
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
  await vi.waitFor(() => expect(f.wires).toHaveLength(2))
  const wire = f.wires[1]!
  wire.open()
  wire.onSend = () => { throw new Error("network send failed") }
  wire.control({ kind: "connected", carrierVersion: 1 })
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  expect(f.opened).not.toHaveBeenCalled()
})

it("refuses a mutation on a closing physical socket as network loss without replay", async () => {
  const f = fixture(), wire = await f.connect(), remote = responder(wire)
  remote.step(); remote.step()
  const sent = wire.sent.length
  wire.readyState = 2
  expect(() => f.socket.send("mutation")).toThrow()
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  expect(wire.sent).toHaveLength(sent)
  expect(remote.received).toEqual([])
  expect(f.wires).toHaveLength(2)
})

it("does not pretend a daemon credential rejection has an authenticated refusal signal on carrier v1", async () => {
  const f = fixture(), wire = await f.connect(), remote = responder(wire, false)
  remote.step()
  expect(() => remote.step()).toThrow("Relay admission rejected")
  // The relay terminates the logical client's physical socket. It does not
  // preserve the daemon's reason, so this is indistinguishable from link loss.
  expect(f.closed).toEqual([1006])
  expect(f.socket.localAdmissionRefusal).toBeUndefined()
  expect(f.opened).not.toHaveBeenCalled()
  expect(remote.received).toEqual([])
})

it("keeps system.hello bearer-free and still requires the paired device receipt through the client facade", async () => {
  const f = fixture()
  const deviceId = `device-${"b".repeat(32)}`
  const client = new DomovoiClient("wss://relay.example/carrier", "web", {
    authToken: "", createSocket: () => f.socket, admission: { machineId, deviceId },
    budgets: { connectMs: 5_000, requestMs: 5_000 },
  })
  cleanup.push(() => client.disconnect())
  const snapshots = vi.fn()
  client.addEventListener("snapshot", snapshots)
  const connected = client.connect()
  const wire = await f.connect(), remote = responder(wire)
  remote.step(); remote.step(); remote.step()
  const hello = JSON.parse(remote.received[0]!)
  expect(hello.method).toBe("system.hello")
  expect(hello.params).not.toHaveProperty("authToken")
  const snapshot = rpcMethods["system.hello"].result.parse({ ...demoWorkspace,
    machine: { ...demoWorkspace.machine, id: machineId }, project: { ...demoWorkspace.project, machineId } })
  remote.server.send(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: snapshot }))
  for (const reply of remote.replies.splice(0)) wire.receive(reply.buffer)
  await flush()
  expect(snapshots).not.toHaveBeenCalled()
  remote.step()
  const receipt = JSON.parse(remote.received[1]!)
  expect(receipt.method).toBe("device.current")
  remote.server.send(JSON.stringify({ jsonrpc: "2.0", id: receipt.id,
    result: { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" } }))
  wire.receive(remote.replies.shift()!.buffer)
  await expect(connected).resolves.toMatchObject({ machine: { id: machineId } })
  expect(snapshots).toHaveBeenCalledTimes(1)
})

it("treats unavailable platform entropy during channel construction as terminal", async () => {
  const f = fixture()
  await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires[0]!.open()
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => { throw new Error("entropy unavailable") })
  f.wires[0]!.control({ kind: "recovery", carrierVersion: 1, recovery: { identity: pin.identity } })
  await vi.waitFor(() => expect(f.closed).toEqual([1008]))
  expect(f.wires).toHaveLength(1)
  expect(f.opened).not.toHaveBeenCalled()
})

it.each([undefined, "corrupt pin"])("reports local saved-pin verification failure without claiming bearer rejection: %s", async (saved) => {
  const f = fixture({ pinStore: { read: async () => saved, compareAndSwap: async () => false } })
  const retry = vi.fn(() => 1), snapshots = vi.fn()
  const client = new DomovoiClient("wss://relay.example/carrier", "web", {
    authToken: "", createSocket: () => f.socket, admission: { machineId },
    budgets: { connectMs: 5_000, requestMs: 5_000 },
    scheduler: { setTimeout: retry, clearTimeout: vi.fn() },
  })
  cleanup.push(() => client.disconnect())
  client.addEventListener("snapshot", snapshots)
  const failure: unknown = await client.connect().catch((error: unknown) => error)
  expect(f.wires).toEqual([])
  expect(f.socket.localAdmissionRefusal).toBe("relay-verification-refused")
  expect(Reflect.set(f.socket, "localAdmissionRefusal", undefined)).toBe(false)
  expect(snapshots).not.toHaveBeenCalled()
  expect(retry).not.toHaveBeenCalled()
  expect(failure).toMatchObject({ name: "ClientAdmissionError", reason: "relay-verification-refused" })
})

it.each(["recovering", "admitting"])("never promotes a peer close reason to the local relay refusal signal while %s", async (stage) => {
  const f = fixture()
  const retry = vi.fn(() => 1)
  const client = new DomovoiClient("wss://relay.example/carrier", "web", {
    authToken: "", createSocket: () => f.socket, admission: { machineId },
    budgets: { connectMs: 5_000, requestMs: 5_000 }, scheduler: { setTimeout: retry, clearTimeout: vi.fn() },
  })
  cleanup.push(() => client.disconnect())
  const outcome = client.connect().catch((error: unknown) => error)
  if (stage === "admitting") await f.connect()
  else await vi.waitFor(() => expect(f.wires).toHaveLength(1))
  f.wires.at(-1)!.lost(1008, "relay-verification-refused")
  await flush()
  expect(await outcome).toMatchObject({ name: "ClientAdmissionError", reason: "client-credential-required" })
  expect(Reflect.get(f.socket, "localAdmissionRefusal")).toBeUndefined()
  expect(retry).not.toHaveBeenCalled()
})
