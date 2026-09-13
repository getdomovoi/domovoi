import { afterEach, describe, expect, it, vi } from "vitest"
import { createNoiseIk } from "../relay/index.js"
import { maximumRelayMessageBytes, relayAdmissionTimeoutMs } from "../src/relay-admission.js"
import { createRelayClient, createRelayResponder, relayPublicKeyFromPrivateKey, type RelayChannel } from "./index.js"

const clientKey = new Uint8Array(32).fill(11)
const serverKey = new Uint8Array(32).fill(12)
const token = "secret_".padEnd(43, "t")
const channels: RelayChannel[] = []
afterEach(() => { for (const channel of channels.splice(0)) channel.close(); vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(accept = true) {
  const context = { relayProtocol: 1 as const, routeId: Buffer.alloc(32, 9).toString("base64url"),
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(serverKey) } }
  const upstream: Uint8Array[] = [], downstream: Uint8Array[] = []
  const clientMessages: string[] = [], serverMessages: string[] = []
  const closed = { client: 0, server: 0 }
  const authorize = vi.fn((supplied: string, key: Uint8Array) => accept && supplied === token
    && Buffer.from(key).toString("base64url") === relayPublicKeyFromPrivateKey(clientKey))
  const client = createRelayClient({ context, staticPrivateKey: clientKey, token,
    carrier: { bufferedAmount: 0, send: (frame) => upstream.push(frame.slice()), close: () => { closed.client++ } },
    onMessage: (message) => clientMessages.push(message) })
  const server = createRelayResponder({ context, staticPrivateKey: serverKey, authorize,
    carrier: { bufferedAmount: 0, send: (frame) => downstream.push(frame.slice()), close: () => { closed.server++ } },
    onMessage: (message) => serverMessages.push(message) })
  channels.push(client, server)
  const take = (frames: Uint8Array[]) => { const frame = frames.shift(); expect(frame).toBeDefined(); return frame! }
  const admit = () => {
    client.start()
    expect(upstream[0]).toHaveLength(96)
    server.receive(take(upstream))
    expect(downstream[0]).toHaveLength(48)
    expect(authorize).not.toHaveBeenCalled()
    client.receive(take(downstream))
    expect(client.admitted).toBe(false)
    server.receive(take(upstream))
    expect(server.admitted).toBe(true)
    client.receive(take(downstream))
    expect(client.admitted).toBe(true)
  }
  return { client, server, context, upstream, downstream, closed, authorize, clientMessages, serverMessages, take, admit }
}

describe("relay admission against the frozen IK codec", () => {
  it("does not clear or alias caller-owned Buffer keys", () => {
    const source = Buffer.alloc(32, 11)
    relayPublicKeyFromPrivateKey(source)
    expect(source).toEqual(Buffer.alloc(32, 11))
  })

  it("keeps the bearer and application records off the carrier plaintext", () => {
    const f = fixture()
    f.client.start()
    const first = f.take(f.upstream)
    expect(first).toHaveLength(96)
    f.server.receive(first)
    const reply = f.take(f.downstream)
    expect(reply).toHaveLength(48)
    f.client.receive(reply)
    const credential = f.take(f.upstream)
    expect(Buffer.from(credential).includes(Buffer.from(token))).toBe(false)
    expect(f.authorize).not.toHaveBeenCalled()
    f.server.receive(credential)
    expect(f.authorize).toHaveBeenCalledWith(token, new Uint8Array(Buffer.from(relayPublicKeyFromPrivateKey(clientKey), "base64url")))
    expect(f.serverMessages).toEqual([])
    f.client.receive(f.take(f.downstream))
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace.get", params: {} })
    f.client.send(message)
    const frame = f.take(f.upstream)
    expect(Buffer.from(frame).includes(Buffer.from(message))).toBe(false)
    f.server.receive(frame)
    expect(f.serverMessages).toEqual([message])
  })

  it("has no application output before the admission receipt", () => {
    const f = fixture()
    f.client.start()
    expect(() => f.client.send("secret application data")).toThrow("Relay admission rejected")
    expect(f.client.closed).toBe(true)
    expect(f.upstream).toHaveLength(1)
    expect(() => f.server.send("secret daemon data")).toThrow("Relay admission rejected")
    expect(f.downstream).toEqual([])
  })

  it("refuses a credential without emitting a plaintext reason or application output", () => {
    const f = fixture(false)
    f.client.start(); f.server.receive(f.take(f.upstream)); f.client.receive(f.take(f.downstream))
    expect(() => f.server.receive(f.take(f.upstream))).toThrow("Relay admission rejected")
    expect(f.server.closed).toBe(true)
    expect(f.closed.server).toBe(1)
    expect(f.downstream).toEqual([])
    expect(f.serverMessages).toEqual([])
  })

  it("rechecks the credential before inbound requests and outbound notifications", () => {
    const f = fixture(); f.admit()
    f.authorize.mockReturnValue(false)
    f.client.send("request after revocation")
    expect(() => f.server.receive(f.take(f.upstream))).toThrow("Relay admission rejected")
    expect(f.serverMessages).toEqual([])
    const g = fixture(); g.admit(); g.authorize.mockReturnValue(false)
    expect(() => g.server.send("notification after revocation")).toThrow("Relay admission rejected")
    expect(g.downstream).toEqual([])
  })

  it("reassembles bounded messages before releasing any bytes to the application", () => {
    const f = fixture(); f.admit()
    const message = "m".repeat(maximumRelayMessageBytes)
    f.client.send(message)
    expect(f.upstream.length).toBeGreaterThan(1)
    expect(f.upstream.every((frame) => frame.length <= 65_535)).toBe(true)
    while (f.upstream.length > 1) { f.server.receive(f.take(f.upstream)); expect(f.serverMessages).toEqual([]) }
    f.server.receive(f.take(f.upstream))
    expect(f.serverMessages).toEqual([message])
    f.server.send("你好🙂")
    f.client.receive(f.take(f.downstream))
    expect(f.clientMessages).toEqual(["你好🙂"])
    expect(() => f.client.send(message + "x")).toThrow("Relay admission rejected")
  })

  it("rejects a replay and closes both directions for that channel", () => {
    const f = fixture(); f.admit(); f.client.send("one")
    const frame = f.take(f.upstream)
    f.server.receive(frame)
    expect(() => f.server.receive(frame)).toThrow("Relay admission rejected")
    expect(() => f.server.send("two")).toThrow("Relay admission rejected")
    expect(f.serverMessages).toEqual(["one"])
  })

  it("expires an unfinished handshake without trusting a carrier clock", () => {
    vi.useFakeTimers()
    const f = fixture()
    f.client.start()
    vi.advanceTimersByTime(relayAdmissionTimeoutMs)
    expect(f.client.closed).toBe(true)
    expect(f.server.closed).toBe(true)
    expect(f.closed).toEqual({ client: 1, server: 1 })
  })

  it("rejects handshake payloads even though the frozen codec can encode them", () => {
    const f = fixture()
    const attacker = createNoiseIk({ role: "initiator", suite: "Noise_IK_25519_ChaChaPoly_SHA256", staticKey: clientKey,
      ephemeralKey: new Uint8Array(32).fill(13), responderPublicKey: new Uint8Array(Buffer.from(f.context.channel.responderPublicKey, "base64url")),
      prologue: new Uint8Array(Buffer.concat([Buffer.from("domovoi.relay.admission.v1\0"), Buffer.alloc(32, 9)])) })
    expect(() => f.server.receive(attacker.writeHandshake(new Uint8Array([1])))).toThrow("Relay admission rejected")
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.downstream).toEqual([])
  })
})
