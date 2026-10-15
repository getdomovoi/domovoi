// Adapter-level integration. This wire is in memory, not a WebSocket server.
import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { demoWorkspace, encodeRelayCarrierControl, parseRelayCarrierControl, rpcMethods, rpcRequestSchema, type RelayClientPin, type RelayRecoveryResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { createRelayResponder, relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes, type RelayChannel } from "@getdomovoi/protocol/relay-admission"
import { DomovoiClient } from "./client.js"
import { createRelaySocket, type RelayWebSocket } from "./relay-carrier.js"
import { Deadline } from "./deadline.js"
import { dialTransport } from "./transport-dial.js"
import { ClientAdmissionError } from "./client-admission-policy.js"

const clientKey = new Uint8Array(32).fill(11), originalKey = new Uint8Array(32).fill(12), successorKey = new Uint8Array(32).fill(13)
const routeId = Buffer.alloc(32, 9).toString("base64url"), token = "paired_".padEnd(43, "x")
const deviceId = `device-${"b".repeat(32)}`
const identityKey = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "08".repeat(32), "hex"), format: "der", type: "pkcs8" })
const pin: RelayClientPin = { version: 1, state: "trusted", identity: { version: 1, machineId: demoWorkspace.machine.id, generation: 1,
  identityPublicKey: createPublicKey(identityKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
  channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(originalKey) } } }
const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks() })
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 })

class MemoryWire extends EventTarget implements RelayWebSocket {
  readyState = 0
  bufferedAmount = 0
  binaryType: BinaryType = "arraybuffer"
  constructor(readonly receiveAtRelay: (wire: MemoryWire, data: string | Uint8Array) => void) { super() }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("Fixture wire closed")
    this.receiveAtRelay(this, typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer).slice())
  }
  close() { this.readyState = 3 }
  open() { if (this.readyState !== 3) { this.readyState = 1; this.dispatchEvent(new Event("open")) } }
  deliver(data: string | Uint8Array) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" ? data : data.slice().buffer })) }
  lose() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })) }
}

function fixture(options: { recovery?: RelayRecoveryResult; serverKey?: Uint8Array; cas?: boolean; casBarrier?: Promise<void> } = {}) {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.annotations[0]!.thread = []
  const annotationId = snapshot.annotations[0]!.id
  let saved = structuredClone(pin), attempts = 0, frames = 0, mutationCount = 0
  let holdReceipt = false, loseMutationReply = false
  let retry: (() => void) | undefined
  const wires: MemoryWire[] = [], channels: RelayChannel[] = [], deadlines: Deadline[] = []
  const requests: Array<{ attempt: number; method: string }> = [], encrypted: Uint8Array[] = []
  const heldReceipts: Array<() => void> = [], delayedFrames: Array<{ wire: MemoryWire; frame: Uint8Array }> = []
  const recovery = options.recovery ?? { identity: pin.identity }
  const cas = vi.fn(async (expected: RelayClientPin, replacement: RelayClientPin) => {
    expect(expected).toEqual(saved)
    if (options.cas === false) return false
    if (options.casBarrier) await options.casBarrier
    saved = structuredClone(replacement); return true
  })
  const client = new DomovoiClient("wss://fixture.invalid/carrier", "web", {
    authToken: "", admission: { machineId: pin.identity.machineId, deviceId }, budgets: { connectMs: 5000, requestMs: 5000 },
    scheduler: { setTimeout(callback) { expect(retry).toBeUndefined(); retry = callback; return 1 }, clearTimeout() { retry = undefined } },
    createSocket() {
      const attempt = ++attempts, deadline = Deadline.start(5000)
      deadlines.push(deadline)
      return createRelaySocket({ endpoint: "wss://fixture.invalid/carrier", machineId: pin.identity.machineId, routeId, token, staticPrivateKey: clientKey,
        pinStore: { read: async () => structuredClone(saved), compareAndSwap: cas }, deadline,
        limits: { windowMs: 1000, maximumMessagesPerWindow: 256, maximumBytesPerWindow: 2_000_000 },
        createWebSocket() {
          let channel: RelayChannel | undefined
          const wire = new MemoryWire((socket, data) => {
            if (++frames > 512) throw new Error("Fixture frame budget exhausted")
            if (typeof data === "string") {
              const record = parseRelayCarrierControl(new TextEncoder().encode(data))
              if (record.kind === "recover") queueMicrotask(() => socket.deliver(new TextDecoder().decode(encodeRelayCarrierControl({ kind: "recovery", carrierVersion: 1, recovery }))))
              else if (record.kind === "connect") {
                expect(saved.identity).toEqual(recovery.identity)
                channel = createRelayResponder({ context: { relayProtocol: 1, routeId, channel: recovery.identity.channel }, staticPrivateKey: options.serverKey ?? originalKey,
                  authorize: (bearer, key) => bearer === token && relayPublicKeyFromPrivateKey(clientKey) === Buffer.from(key).toString("base64url"),
                  carrier: { bufferedAmount: 0, send(frame) { encrypted.push(frame.slice()); queueMicrotask(() => { if (socket.readyState === 1) socket.deliver(frame) }) }, close: () => socket.lose() },
                  onMessage(text) {
                    const request = rpcRequestSchema.parse(JSON.parse(text))
                    requests.push({ attempt, method: request.method })
                    const reply = (result: unknown) => channel!.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
                    if (request.method === "system.hello") {
                      expect(request.params).not.toHaveProperty("authToken")
                      reply(rpcMethods["system.hello"].result.parse(snapshot))
                    } else if (request.method === "device.current") {
                      const receipt = () => reply({ kind: "client", machineId: pin.identity.machineId, deviceId, client: "web", clientAccess: "full" })
                      if (holdReceipt) heldReceipts.push(receipt); else receipt()
                    } else if (request.method === "annotation.reply") {
                      const params = rpcMethods["annotation.reply"].params.parse(request.params)
                      expect(params.annotationId).toBe(annotationId)
                      mutationCount++
                      snapshot.annotations[0]!.thread.push({ id: `reply-${mutationCount}`, body: params.body, origin: "web", createdAt: new Date().toISOString() })
                      if (loseMutationReply) {
                        // Prepare an authentic stale response, then lose it after the effect.
                        const send = channel!.send.bind(channel)
                        const before = encrypted.length
                        send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: snapshot }))
                        for (const frame of encrypted.slice(before)) delayedFrames.push({ wire: socket, frame })
                        socket.lose()
                      } else reply(snapshot)
                    } else if (request.method === "workspace.get") reply(snapshot)
                    else throw new Error("Unexpected fixture RPC")
                  },
                })
                channels.push(channel)
                queueMicrotask(() => socket.deliver(new TextDecoder().decode(encodeRelayCarrierControl({ kind: "connected", carrierVersion: 1 }))))
              } else throw new Error("Unexpected fixture greeting")
            } else { encrypted.push(data.slice()); channel!.receive(data) }
          })
          wires.push(wire); queueMicrotask(() => wire.open()); return wire
        },
      })
    },
  })
  cleanups.push(() => { client.disconnect(); for (const wire of wires) wire.close(); for (const channel of channels) channel.close(); for (const deadline of deadlines) deadline.clear() })
  return { client, snapshot, annotationId, requests, encrypted, wires, cas, heldReceipts, delayedFrames,
    get saved() { return saved }, get attempts() { return attempts }, get mutationCount() { return mutationCount },
    holdReceipt() { holdReceipt = true }, loseMutationReply() { loseMutationReply = true },
    reconnect() { expect(retry).toBeTypeOf("function"); const callback = retry!; retry = undefined; callback() },
    get retryPending() { return retry !== undefined },
  }
}

it("refreshes canonical state after a lost mutation reply without replay and waits for a fresh device receipt", async () => {
  const f = fixture(), snapshots: WorkspaceSnapshot[] = []
  f.client.addEventListener("snapshot", (event) => snapshots.push((event as CustomEvent<WorkspaceSnapshot>).detail))
  await f.client.connect()
  expect(snapshots).toHaveLength(1)
  f.loseMutationReply()
  await expect(f.client.request("annotation.reply", { annotationId: f.annotationId, body: "synthetic mutation", client: "web" })).rejects.toThrow("closed")
  expect(f.mutationCount).toBe(1)
  f.holdReceipt(); f.reconnect()
  await wait(() => expect(f.heldReceipts).toHaveLength(1))
  expect(snapshots).toHaveLength(1)
  expect(f.delayedFrames.length).toBeGreaterThan(0)
  for (const delayed of f.delayedFrames) delayed.wire.deliver(delayed.frame)
  expect(snapshots).toHaveLength(1)
  f.heldReceipts[0]!()
  await wait(() => expect(snapshots).toHaveLength(2))
  expect(snapshots[1]!.annotations[0]!.thread).toHaveLength(1)
  expect(f.requests.filter((record) => record.attempt === 2).map((record) => record.method)).toEqual(["system.hello", "device.current"])
  expect(f.mutationCount).toBe(1)
  expect(f.encrypted.some((frame) => Buffer.from(frame).includes(Buffer.from(token)))).toBe(false)
  expect(f.encrypted.some((frame) => Buffer.from(frame).includes(Buffer.from("synthetic mutation")))).toBe(false)
})

function successor(): RelayRecoveryResult {
  const identity = { ...pin.identity, generation: 2, channel: { ...pin.identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(successorKey) } }
  const statement = { ...identity, previousChannelPublicKey: pin.identity.channel.responderPublicKey }
  return { identity, successor: { statement, signature: sign(null, relaySuccessorSigningBytes(statement), identityKey).toString("base64url") } }
}

it("waits for successor storage acknowledgement before fresh Noise and client admission", async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const recovery = successor(), f = fixture({ recovery, serverKey: successorKey, casBarrier: barrier })
  const connecting = f.client.connect().then((value) => ({ value }), (error: unknown) => ({ error }))
  try {
    await wait(() => expect(f.cas).toHaveBeenCalledOnce())
    expect(f.saved).toEqual(pin)
    expect(f.wires).toHaveLength(1)
    expect(f.requests).toEqual([])
  } finally { release() }
  await expect(connecting).resolves.toMatchObject({ value: { machine: { id: pin.identity.machineId } } })
  expect(f.cas).toHaveBeenCalledOnce()
  expect(f.saved.identity).toEqual(recovery.identity)
  expect(f.requests.map((record) => record.method)).toEqual(["system.hello", "device.current"])
})

it.each(["forged", "cas-refused"])("never opens an application channel for %s successor recovery", async (fault) => {
  const recovery = successor()
  if (fault === "forged") recovery.successor!.signature = Buffer.alloc(64, 1).toString("base64url")
  const f = fixture({ recovery, serverKey: successorKey, cas: fault !== "cas-refused" })
  await expect(f.client.connect()).rejects.toMatchObject({ reason: "relay-verification-refused" })
  expect(f.wires).toHaveLength(1)
  expect(f.requests).toEqual([])
  expect(f.retryPending).toBe(false)
  expect(f.saved).toEqual(pin)
})

it("falls through a fixture direct outage into actual encrypted adapter admission", async () => {
  const f = fixture(), calls: string[] = []
  const relay = { kind: "relay" as const, endpoint: "wss://fixture.invalid/carrier", authenticated: true as const }
  const direct = { kind: "lan" as const, endpoint: "wss://direct.invalid/rpc", authenticated: true as const }
  const result = await dialTransport<WorkspaceSnapshot>({ candidates: [relay, direct], credential: token,
    connect: async ({ endpoint }) => { expect(endpoint).toBe(direct.endpoint); calls.push("direct"); throw new Error("synthetic network outage") },
    connectRelay: async ({ endpoint }) => { expect(endpoint).toBe(relay.endpoint); calls.push("relay"); return f.client.connect() },
  })
  expect(calls).toEqual(["direct", "relay"])
  expect(result.transport).toEqual(relay)
  expect(result.connection.machine.id).toBe(pin.identity.machineId)
  expect(f.requests.map((request) => request.method)).toEqual(["system.hello", "device.current"])
})

it("never creates a relay adapter after terminal direct identity refusal", async () => {
  const f = fixture(), failure = new ClientAdmissionError("identity-mismatch")
  const relay = vi.fn(() => f.client.connect())
  await expect(dialTransport({ candidates: [
    { kind: "relay", endpoint: "wss://fixture.invalid/carrier", authenticated: true },
    { kind: "lan", endpoint: "wss://direct.invalid/rpc", authenticated: true },
  ], credential: token, connect: async () => { throw failure }, connectRelay: relay })).rejects.toBe(failure)
  expect(relay).not.toHaveBeenCalled()
  expect(f.attempts).toBe(0)
  expect(f.wires).toEqual([])
  expect(f.requests).toEqual([])
})
