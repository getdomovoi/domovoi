import { generateKeyPairSync, randomBytes, sign } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { relayPublicKeyFromPrivateKey } from "../relay-admission/channel.js"
import { relaySuccessorSigningBytes } from "../relay-admission/identity.js"
import { maximumRelayFrameBytes } from "./relay-admission.js"
import {
  decodeRelayMultiplexedFrame,
  encodeRelayCarrierControl,
  encodeRelayMultiplexedFrame,
  maximumRelayCarrierControlBytes,
  maximumRelayMultiplexedFrameBytes,
  parseRelayCarrierControl,
  relayCarrierControlSchema,
  relayCarrierGreetingSchema,
  relayCarrierVersion,
  relayMultiplexHeaderBytes,
} from "./relay-carrier.js"

function fixture() {
  const machineId = "machine-" + "a".repeat(32)
  const signer = generateKeyPairSync("ed25519")
  const channel = () => {
    const key = randomBytes(32)
    try { return { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(key) } }
    finally { key.fill(0) }
  }
  const identity = { version: 1 as const, machineId, generation: 1,
    identityPublicKey: signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"), channel: channel() }
  const next = { ...identity, generation: 2, channel: channel() }
  const statement = { ...next, previousChannelPublicKey: identity.channel.responderPublicKey }
  const recovery = { identity: next, successor: { statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") } }
  const routeId = randomBytes(32).toString("base64url")
  const registration = { kind: "register" as const, carrierVersion: relayCarrierVersion, routeId, machineId,
    generation: 1, registrationCredential: randomBytes(32).toString("base64url"), recovery }
  return { registration, recovery, routeId, machineId }
}

describe("relay carrier control records", () => {
  it("round trips registration, connection, public recovery and channel control", () => {
    const f = fixture()
    const messages = [
      f.registration,
      { kind: "connect", carrierVersion: relayCarrierVersion, routeId: f.routeId },
      { kind: "recover", carrierVersion: relayCarrierVersion, routeId: f.routeId, machineId: f.machineId },
      { kind: "registered", carrierVersion: relayCarrierVersion, generation: 1 },
      { kind: "connected", carrierVersion: relayCarrierVersion },
      { kind: "recovery", recovery: f.recovery },
      { kind: "open", channelId: 1 },
      { kind: "close", channelId: 0xffff_ffff },
    ]
    for (const message of messages) {
      const encoded = encodeRelayCarrierControl(message)
      expect(encoded.byteLength).toBeLessThanOrEqual(maximumRelayCarrierControlBytes)
      expect(parseRelayCarrierControl(encoded)).toEqual(JSON.parse(JSON.stringify(message)))
    }
  })

  it("accepts only role greetings before a channel exists", () => {
    const f = fixture()
    for (const message of [f.registration,
      { kind: "connect", carrierVersion: 1, routeId: f.routeId },
      { kind: "recover", carrierVersion: 1, routeId: f.routeId, machineId: f.machineId },
    ]) expect(relayCarrierGreetingSchema.safeParse(message).success).toBe(true)
    for (const message of [{ kind: "open", channelId: 1 }, { kind: "close", channelId: 1 },
      { kind: "connected", carrierVersion: 1 }, { kind: "recovery", recovery: f.recovery },
    ]) expect(relayCarrierGreetingSchema.safeParse(message).success).toBe(false)
  })

  it("refuses unknown versions, fields, identifiers and unsafe generations", () => {
    const { registration } = fixture()
    for (const patch of [
      { carrierVersion: 2 }, { kind: "unknown" }, { routeId: "not-a-route" },
      { routeId: registration.routeId + "=" }, { machineId: "other" },
      { registrationCredential: "short" }, { registrationCredential: "A".repeat(44) },
      { generation: 0 }, { generation: -1 }, { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 }, { generation: Infinity },
      { token: "unexpected" }, { privateKey: "unexpected" },
    ]) expect(relayCarrierControlSchema.safeParse({ ...registration, ...patch }).success).toBe(false)
    expect(relayCarrierControlSchema.safeParse({ ...registration, generation: Number.MAX_SAFE_INTEGER }).success).toBe(true)
    expect(() => encodeRelayCarrierControl({ kind: "missing" })).toThrow()
  })

  it("binds a registration's recovery publication to its machine", () => {
    const { registration } = fixture()
    expect(relayCarrierControlSchema.safeParse({ ...registration, machineId: "machine-" + "b".repeat(32) }).success).toBe(false)
    expect(relayCarrierControlSchema.safeParse({ ...registration, recovery: { identity: registration.recovery.identity } }).success).toBe(false)
  })

  it("requires a recovery publication before registering a relay route", () => {
    const { registration } = fixture()
    expect(relayCarrierControlSchema.safeParse({ ...registration, recovery: undefined }).success).toBe(false)
  })

  it("public recovery requests accept no bearer or caller-supplied trust anchor", () => {
    const f = fixture()
    const request = { kind: "recover", carrierVersion: 1, routeId: f.routeId, machineId: f.machineId }
    for (const extra of [{ token: "unexpected" }, { registrationCredential: "unexpected" },
      { identityPublicKey: f.recovery.identity.identityPublicKey }, { recovery: f.recovery },
    ]) expect(relayCarrierControlSchema.safeParse({ ...request, ...extra }).success).toBe(false)
  })

  it("refuses oversized control input before JSON parsing", () => {
    const parse = vi.spyOn(JSON, "parse")
    try {
      expect(() => parseRelayCarrierControl(new Uint8Array(maximumRelayCarrierControlBytes + 1))).toThrow()
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
    const wire = encodeRelayCarrierControl({ kind: "close", channelId: 1 })
    const padded = new Uint8Array(maximumRelayCarrierControlBytes).fill(32)
    padded.set(wire)
    expect(parseRelayCarrierControl(padded)).toEqual({ kind: "close", channelId: 1 })
  })

  it("refuses invalid UTF-8, malformed JSON and non-control records", () => {
    for (const bytes of [Uint8Array.of(0x80), new Uint8Array(), new TextEncoder().encode("{"),
      new TextEncoder().encode("null"), new TextEncoder().encode("[]"),
      new TextEncoder().encode('{"kind":"close","channelId":0}'),
    ]) expect(() => parseRelayCarrierControl(bytes)).toThrow()
    expect(() => parseRelayCarrierControl(new ArrayBuffer(4) as unknown as Uint8Array)).toThrow()
  })
})

describe("relay carrier multiplexing layout", () => {
  it("pins the four-byte little-endian channel header and untouched frame tail", () => {
    expect(relayCarrierVersion).toBe(1)
    expect(relayMultiplexHeaderBytes).toBe(4)
    expect(maximumRelayCarrierControlBytes).toBe(4_096)
    expect(maximumRelayMultiplexedFrameBytes).toBe(65_539)
    expect(encodeRelayMultiplexedFrame(0x0102_0304, Uint8Array.of(255, 0, 17))).toEqual(Uint8Array.of(4, 3, 2, 1, 255, 0, 17))
    expect(decodeRelayMultiplexedFrame(Uint8Array.of(4, 3, 2, 1, 255, 0, 17))).toEqual({ channelId: 0x0102_0304, frame: Uint8Array.of(255, 0, 17) })
  })

  it("preserves complete minimum and maximum opaque frames", () => {
    for (const length of [1, 48, 96, maximumRelayFrameBytes]) {
      const frame = Uint8Array.from({ length }, (_, index) => index % 256)
      const wire = encodeRelayMultiplexedFrame(0xffff_ffff, frame)
      expect(wire.byteLength).toBe(length + relayMultiplexHeaderBytes)
      expect(decodeRelayMultiplexedFrame(wire)).toEqual({ channelId: 0xffff_ffff, frame })
    }
  })

  it("handles offset views and owns decoded bytes even when input is a Node Buffer", () => {
    const frame = Buffer.from([23, 255])
    const encoded = encodeRelayMultiplexedFrame(1, frame)
    frame.fill(0)
    const backing = Buffer.alloc(encoded.byteLength + 6)
    backing.set(encoded, 3)
    const decoded = decodeRelayMultiplexedFrame(backing.subarray(3, -3))
    backing.fill(0)
    expect(decoded.frame).toEqual(Uint8Array.of(23, 255))
    expect(decoded.channelId).toBe(1)
  })

  it("refuses zero, unsafe or out-of-range channels and empty or oversized frames", () => {
    for (const channelId of [0, -1, 1.5, Infinity, 0x1_0000_0000, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeRelayMultiplexedFrame(channelId, Uint8Array.of(1))).toThrow()
    }
    for (const frame of [new Uint8Array(), new Uint8Array(maximumRelayFrameBytes + 1), {} as Uint8Array]) {
      expect(() => encodeRelayMultiplexedFrame(1, frame)).toThrow()
    }
    for (const frame of [new Uint8Array(4), new Uint8Array(maximumRelayMultiplexedFrameBytes + 1),
      Uint8Array.of(0, 0, 0, 0, 1), {} as Uint8Array,
    ]) expect(() => decodeRelayMultiplexedFrame(frame)).toThrow()
  })
})
