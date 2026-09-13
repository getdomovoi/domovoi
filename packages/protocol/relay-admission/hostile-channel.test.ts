import { afterEach, describe, expect, it, vi } from "vitest"
import { createNoiseIk } from "../relay/index.js"
import { maximumRelayAdmissionBytes, maximumRelayBufferedBytes, maximumRelayChunkBytes, maximumRelayMessageBytes, relayAdmissionTimeoutMs, relayMessageTimeoutMs } from "../src/relay-admission.js"
import { createRelayClient, createRelayResponder, relayPublicKeyFromPrivateKey, type RelayChannel } from "./index.js"

const clientKey = new Uint8Array(32).fill(11), serverKey = new Uint8Array(32).fill(12)
const token = "secret_".padEnd(43, "t"), suite = "Noise_IK_25519_ChaChaPoly_SHA256" as const
const context = { relayProtocol: 1 as const, routeId: Buffer.alloc(32, 9).toString("base64url"), channel: { suite, responderPublicKey: relayPublicKeyFromPrivateKey(serverKey) } }
// Independent wire builder. No production prologue/header helpers.
const prologue = () => new Uint8Array(Buffer.concat([Buffer.from("domovoi.relay.admission.v1\0"), Buffer.alloc(32, 9)]))
const control = (kind: number, json: string) => new Uint8Array(Buffer.concat([Buffer.from([kind]), Buffer.from(json)]))
const credential = () => control(0, JSON.stringify({ kind: "credential", token }))
function fragment(total: number, offset: number, data: Uint8Array, kind = 2): Uint8Array {
  const bytes = Buffer.alloc(9 + data.length)
  bytes[0] = kind; bytes.writeUInt32LE(total, 1); bytes.writeUInt32LE(offset, 5); bytes.set(data, 9)
  return new Uint8Array(bytes)
}
const channels: RelayChannel[] = []
afterEach(() => { for (const channel of channels.splice(0)) channel.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function maliciousClient() {
  const sent: Uint8Array[] = [], messages: string[] = []
  const close = vi.fn(), authorize = vi.fn((_token: string, _key: Uint8Array) => true), onAdmitted = vi.fn()
  const carrier = { bufferedAmount: 0, send: (frame: Uint8Array) => { sent.push(frame) }, close }
  const server = createRelayResponder({ context, staticPrivateKey: serverKey, carrier, authorize, onAdmitted, onMessage: (message) => messages.push(message) })
  channels.push(server)
  const peer = createNoiseIk({ role: "initiator", suite, staticKey: clientKey, ephemeralKey: new Uint8Array(32).fill(13), responderPublicKey: new Uint8Array(Buffer.from(context.channel.responderPublicKey, "base64url")), prologue: prologue() })
  server.receive(peer.writeHandshake(new Uint8Array()))
  expect(peer.readHandshake(sent.shift()!)).toEqual(new Uint8Array())
  const admit = () => { server.receive(peer.encrypt(credential())); expect(peer.decrypt(sent.shift()!)).toEqual(control(1, '{"kind":"admitted"}')) }
  return { server, peer, sent, messages, close, authorize, onAdmitted, carrier, admit }
}
function maliciousServer() {
  const sent: Uint8Array[] = [], messages: string[] = [], close = vi.fn(), onAdmitted = vi.fn()
  const client = createRelayClient({ context, staticPrivateKey: clientKey, token, onAdmitted, carrier: { bufferedAmount: 0, send: (frame) => { sent.push(frame) }, close }, onMessage: (message) => messages.push(message) })
  channels.push(client)
  const peer = createNoiseIk({ role: "responder", suite, staticKey: serverKey, ephemeralKey: new Uint8Array(32).fill(14), prologue: prologue() })
  client.start(); peer.readHandshake(sent.shift()!)
  const handshake = () => { client.receive(peer.writeHandshake(new Uint8Array())); expect(peer.decrypt(sent.shift()!)).toEqual(credential()) }
  return { client, peer, sent, close, messages, onAdmitted, handshake }
}

describe("encrypted admission refusal boundaries", () => {
  it.each([
    ["wrong type", control(2, '{"kind":"credential"}')], ["wrong kind", control(0, JSON.stringify({ kind: "admitted", token }))],
    ["short token", control(0, '{"kind":"credential","token":"short"}')], ["unknown field", control(0, JSON.stringify({ kind: "credential", token, bypass: true }))],
    ["invalid JSON", control(0, '{')], ["invalid UTF-8", new Uint8Array([0, 0xff])], ["empty", new Uint8Array()],
    ["over cap", control(0, ' '.repeat(maximumRelayAdmissionBytes))],
  ])("refuses %s credentials before lookup or application output", (_name, payload) => {
    const f = maliciousClient()
    expect(() => f.server.receive(f.peer.encrypt(payload as Uint8Array))).toThrow("Relay admission rejected")
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.onAdmitted).not.toHaveBeenCalled()
    expect(f.messages).toEqual([]); expect(f.sent).toEqual([]); expect(f.close).toHaveBeenCalledTimes(1)
  })
  it.each([control(0, '{"kind":"admitted"}'), control(1, '{"kind":"admitted","extra":1}'), control(1, '{"kind":"refused"}')])("requires an exact encrypted admission receipt", (payload) => {
    const f = maliciousServer(); f.handshake()
    expect(() => f.client.receive(f.peer.encrypt(payload))).toThrow("Relay admission rejected")
    expect(f.onAdmitted).not.toHaveBeenCalled(); expect(f.messages).toEqual([])
  })
  it("refuses a nonempty second handshake with valid prologue and keys", () => {
    const f = maliciousServer()
    expect(() => f.client.receive(f.peer.writeHandshake(new Uint8Array([1])))).toThrow("Relay admission rejected")
    expect(f.sent).toEqual([])
  })
  it("accepts a valid credential at the admission byte cap", () => {
    const f = maliciousClient(), padded = new Uint8Array(maximumRelayAdmissionBytes).fill(32)
    padded.set(credential()); f.server.receive(f.peer.encrypt(padded))
    expect(f.authorize).toHaveBeenCalledTimes(1); expect(f.server.admitted).toBe(true)
  })
  it("uses fresh ephemerals and rejects a response from another handshake", () => {
    const a = maliciousServer(), b = maliciousServer()
    const responseA = a.peer.writeHandshake(new Uint8Array()), responseB = b.peer.writeHandshake(new Uint8Array())
    expect(responseA).not.toEqual(responseB)
    expect(() => b.client.receive(responseA)).toThrow("Relay admission rejected")
  })
  it.each(["route", "pin"])("refuses a substituted %s before sending a bearer", (kind) => {
    const sent: Uint8Array[] = [], close = vi.fn()
    const changed = kind === "route" ? { ...context, routeId: Buffer.alloc(32, 8).toString("base64url") } : { ...context, channel: { suite, responderPublicKey: relayPublicKeyFromPrivateKey(new Uint8Array(32).fill(15)) } }
    const client = createRelayClient({ context: changed, staticPrivateKey: clientKey, token, carrier: { bufferedAmount: 0, send: (frame) => { sent.push(frame) }, close }, onMessage: vi.fn() })
    channels.push(client); client.start()
    const peer = createNoiseIk({ role: "responder", suite, staticKey: serverKey, ephemeralKey: new Uint8Array(32).fill(14), prologue: prologue() })
    expect(() => peer.readHandshake(sent[0]!)).toThrow(); expect(sent).toHaveLength(1)
  })
  it.each(["throw", "truthy"])("refuses an authorization callback that returns %s", (failure) => {
    const f = maliciousClient()
    if (failure === "throw") f.authorize.mockImplementation(() => { throw new Error(token) })
    else f.authorize.mockReturnValue("yes" as unknown as boolean)
    expect(() => f.server.receive(f.peer.encrypt(credential()))).toThrow(/^Relay admission rejected$/)
    expect(f.sent).toEqual([]); expect(f.server.closed).toBe(true)
  })
  it("gives authorization a fresh copy of the authenticated peer key", () => {
    const f = maliciousClient(), keys: Uint8Array[] = []
    f.authorize.mockImplementation((_token, key) => { keys.push(key.slice()); key.fill(0); return true })
    f.admit(); f.server.receive(f.peer.encrypt(fragment(1, 0, new Uint8Array([65]))))
    expect(keys).toEqual([0, 1].map(() => new Uint8Array(Buffer.from(relayPublicKeyFromPrivateKey(clientKey), "base64url"))))
  })
})

describe("application records above Noise", () => {
  it.each([
    ["short header", new Uint8Array([2])], ["wrong type", fragment(0, 0, new Uint8Array(), 0)],
    ["over budget", fragment(maximumRelayMessageBytes + 1, 0, new Uint8Array(maximumRelayChunkBytes))],
    ["offset gap", fragment(3, 1, new Uint8Array([65, 66]))], ["offset beyond total", fragment(1, 2, new Uint8Array())],
    ["short fragment", fragment(2, 0, new Uint8Array([65]))], ["long fragment", fragment(0, 0, new Uint8Array([65]))],
    ["invalid UTF-8", fragment(1, 0, new Uint8Array([0xff]))],
  ])("rejects %s before application dispatch", (_name, record) => {
    const f = maliciousClient(); f.admit()
    expect(() => f.server.receive(f.peer.encrypt(record as Uint8Array))).toThrow("Relay admission rejected")
    expect(f.messages).toEqual([]); expect(f.server.closed).toBe(true)
  })
  it("rejects interleaving even when the offset continues the first message", () => {
    const f = maliciousClient(); f.admit()
    f.server.receive(f.peer.encrypt(fragment(maximumRelayChunkBytes + 2, 0, new Uint8Array(maximumRelayChunkBytes))))
    expect(() => f.server.receive(f.peer.encrypt(fragment(maximumRelayChunkBytes + 1, maximumRelayChunkBytes, new Uint8Array(1))))).toThrow("Relay admission rejected")
    expect(f.messages).toEqual([])
  })
  it("preserves UTF-8 across a full-size fragment boundary and accepts an empty message", () => {
    const f = maliciousClient(); f.admit()
    const message = "a".repeat(maximumRelayChunkBytes - 1) + "🙂", bytes = new TextEncoder().encode(message)
    f.server.receive(f.peer.encrypt(fragment(bytes.length, 0, bytes.subarray(0, maximumRelayChunkBytes))))
    expect(f.messages).toEqual([])
    f.server.receive(f.peer.encrypt(fragment(bytes.length, maximumRelayChunkBytes, bytes.subarray(maximumRelayChunkBytes))))
    expect(f.messages).toEqual([message])
    f.server.receive(f.peer.encrypt(fragment(0, 0, new Uint8Array())))
    expect(f.messages).toEqual([message, ""])
  })
  it.each(["tamper", "reorder"])("closes on ciphertext %s without releasing plaintext", (kind) => {
    const f = maliciousClient(); f.admit()
    const first = f.peer.encrypt(fragment(1, 0, new Uint8Array([65]))), second = f.peer.encrypt(fragment(1, 0, new Uint8Array([66])))
    if (kind === "tamper") first[first.length - 1]! ^= 1
    expect(() => f.server.receive(kind === "tamper" ? first : second)).toThrow("Relay admission rejected")
    expect(f.messages).toEqual([])
  })
  it("does not refresh the message deadline on another fragment", () => {
    vi.useFakeTimers()
    const f = maliciousClient(); f.admit(); const total = maximumRelayChunkBytes * 3
    f.server.receive(f.peer.encrypt(fragment(total, 0, new Uint8Array(maximumRelayChunkBytes))))
    vi.advanceTimersByTime(relayMessageTimeoutMs - 1)
    f.server.receive(f.peer.encrypt(fragment(total, maximumRelayChunkBytes, new Uint8Array(maximumRelayChunkBytes))))
    vi.advanceTimersByTime(1)
    expect(f.server.closed).toBe(true); expect(f.messages).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it("clears deadlines after admission and complete messages", () => {
    vi.useFakeTimers()
    const f = maliciousClient(); f.admit(); f.server.receive(f.peer.encrypt(fragment(1, 0, new Uint8Array([65]))))
    vi.advanceTimersByTime(relayAdmissionTimeoutMs + relayMessageTimeoutMs)
    expect(f.server.admitted).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([-1, NaN, Infinity, 1.5, maximumRelayBufferedBytes])("refuses carrier backlog %s before emitting data", (bufferedAmount) => {
    const f = maliciousClient(); f.admit(); f.carrier.bufferedAmount = bufferedAmount
    expect(() => f.server.send("secret")).toThrow("Relay admission rejected")
    expect(f.sent).toEqual([]); expect(f.close).toHaveBeenCalledTimes(1)
  })
  it("accepts the exact queue cap and refuses UTF-8 byte overflow", () => {
    const f = maliciousClient(); f.admit()
    f.carrier.bufferedAmount = maximumRelayBufferedBytes - 26 // one byte + 9 header + 16 tag
    f.server.send("a"); expect(f.sent).toHaveLength(1)
    expect(() => f.server.send("🙂".repeat(maximumRelayMessageBytes / 2))).toThrow("Relay admission rejected")
    expect(f.sent).toHaveLength(1)
  })
  it("closes on carrier failure without exposing its exception", () => {
    const f = maliciousClient(); f.admit()
    f.carrier.send = () => { throw new Error(token) }; f.carrier.close.mockImplementation(() => { throw new Error(token) })
    expect(() => f.server.send("data")).toThrow(/^Relay admission rejected$/)
    expect(f.server.closed).toBe(true); f.server.close(); expect(f.close).toHaveBeenCalledTimes(1)
  })
  it("refuses duplicate start and input before start", () => {
    const a = maliciousServer(); expect(() => a.client.start()).toThrow("Relay admission rejected")
    const b = createRelayClient({ context, staticPrivateKey: clientKey, token, carrier: { bufferedAmount: 0, send: vi.fn(), close: vi.fn() }, onMessage: vi.fn() })
    channels.push(b); expect(() => b.receive(new Uint8Array(48))).toThrow("Relay admission rejected")
  })
})

describe("channel construction failures", () => {
  it.each(["key length", "pin mismatch", "context", "token", "entropy"])("closes the carrier on %s refusal", (kind) => {
    const carrier = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() }, onMessage = vi.fn()
    if (kind === "entropy") vi.stubGlobal("crypto", { getRandomValues: () => { throw new Error("no entropy") } })
    const options = { context: kind === "context" ? { ...context, relayProtocol: 2 as 1 } : context,
      staticPrivateKey: kind === "key length" ? new Uint8Array(31) : clientKey, token: kind === "token" ? "bad" : token, carrier, onMessage }
    expect(() => kind === "pin mismatch" ? createRelayResponder({ ...options, authorize: () => true }) : createRelayClient(options)).toThrow(/^Relay admission rejected$/)
    expect(carrier.close).toHaveBeenCalledTimes(1); expect(carrier.send).not.toHaveBeenCalled()
  })
})
