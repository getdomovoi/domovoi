import { createPrivateKey, createPublicKey, sign } from "node:crypto"

import { describe, expect, it } from "vitest"

import { relayPublicKeyFromPrivateKey } from "../relay-admission/channel.js"
import { relayIdentityPublicKeyIsValid, relaySuccessorSigningBytes, verifyRelayChannelSuccessor } from "../relay-admission/identity.js"
import { relayIdentityPinSchema, relaySignedSuccessorSchema, type RelayIdentityPin } from "./relay-identity.js"

const externalIdentity = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"),
  format: "der", type: "pkcs8",
})
const identityPublicKey = createPublicKey(externalIdentity).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
const channelKey = (byte: number) => relayPublicKeyFromPrivateKey(new Uint8Array(32).fill(byte))
const current: RelayIdentityPin = {
  version: 1, machineId: "machine-" + "a".repeat(32), identityPublicKey, generation: 1,
  channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: channelKey(1) },
}
const statement = {
  version: 1 as const, machineId: current.machineId, identityPublicKey,
  generation: 2, previousChannelPublicKey: current.channel.responderPublicKey,
  channel: { ...current.channel, responderPublicKey: channelKey(2) },
}
const signed = (value = statement) => ({ statement: value, signature: sign(null, relaySuccessorSigningBytes(value), externalIdentity).toString("base64url") })

describe("relay identity successor", () => {
  it("verifies an off-profile Ed25519 signer and returns only the new public pin", () => {
    expect(verifyRelayChannelSuccessor(current, signed())).toEqual({ ...current, generation: 2, channel: statement.channel })
    expect(current.generation).toBe(1)
  })

  it("pins the domain and every signed field independently of the serializer", () => {
    expect(new TextDecoder().decode(relaySuccessorSigningBytes(statement))).toBe(
      "domovoi.relay-channel-successor.v1\0" + JSON.stringify([
        1, current.machineId, identityPublicKey, 2, current.channel.responderPublicKey,
        "Noise_IK_25519_ChaChaPoly_SHA256", channelKey(2),
      ]),
    )
  })

  it.each([
    ["machine", { machineId: "machine-" + "b".repeat(32) }],
    ["generation", { generation: 3 }],
    ["predecessor", { previousChannelPublicKey: channelKey(3) }],
    ["unchanged key", { channel: current.channel }],
  ])("refuses a correctly signed but inapplicable %s", (_name, changes) => {
    expect(() => verifyRelayChannelSuccessor(current, signed({ ...statement, ...changes }))).toThrow("Relay identity successor rejected")
  })

  it("refuses replay after advancing and refuses exhausted generations", () => {
    const envelope = signed()
    const next = verifyRelayChannelSuccessor(current, envelope)
    expect(() => verifyRelayChannelSuccessor(next, envelope)).toThrow("Relay identity successor rejected")
    expect(() => verifyRelayChannelSuccessor({ ...current, generation: Number.MAX_SAFE_INTEGER }, envelope)).toThrow("Relay identity successor rejected")
  })

  it("refuses low-order and noncanonical channel keys even with a valid identity signature", () => {
    const alias = Buffer.from(current.channel.responderPublicKey, "base64url")
    alias[31] = alias[31]! | 0x80
    for (const key of [Buffer.from([1, ...new Uint8Array(31)]).toString("base64url"), alias.toString("base64url")]) {
      expect(() => verifyRelayChannelSuccessor(current, signed({ ...statement, channel: { ...statement.channel, responderPublicKey: key } }))).toThrow("Relay identity successor rejected")
    }
  })

  it("refuses tampering, another identity, malformed signatures and extra private fields", () => {
    const envelope = signed()
    for (const value of [
      { ...envelope, statement: { ...statement, channel: { ...statement.channel, responderPublicKey: channelKey(3) } } },
      { ...envelope, statement: { ...statement, identityPublicKey: channelKey(3) } },
      { ...envelope, signature: "A".repeat(86) },
      { ...envelope, privateKey: "must-not-be-accepted" },
      { ...envelope, statement: { ...statement, identityPrivateKey: "must-not-be-accepted" } },
      null,
    ]) expect(() => verifyRelayChannelSuccessor(current, value)).toThrow("Relay identity successor rejected")
  })

  it("rejects signatures over an unprefixed or differently ordered message", () => {
    const signature = sign(null, Buffer.from(JSON.stringify(statement)), externalIdentity).toString("base64url")
    expect(() => verifyRelayChannelSuccessor(current, { statement, signature })).toThrow("Relay identity successor rejected")
  })

  it("validates canonical bounds, rejects identity private fields and invalid points", () => {
    expect(relayIdentityPinSchema.safeParse(current).success).toBe(true)
    expect(relaySignedSuccessorSchema.safeParse(signed()).success).toBe(true)
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(relayIdentityPinSchema.safeParse({ ...current, generation }).success).toBe(false)
    }
    expect(relayIdentityPinSchema.safeParse({ ...current, privateKey: "secret" }).success).toBe(false)
    expect(relayIdentityPublicKeyIsValid(identityPublicKey)).toBe(true)
    for (const key of ["A".repeat(43), Buffer.from([1, ...new Uint8Array(31)]).toString("base64url"), Buffer.alloc(32, 255).toString("base64url"), "!", "x".repeat(65)]) {
      expect(relayIdentityPublicKeyIsValid(key)).toBe(false)
    }
    expect(() => verifyRelayChannelSuccessor({ ...current, identityPublicKey: "!" }, signed())).toThrow("Relay identity successor rejected")
    expect(relaySignedSuccessorSchema.safeParse({ ...signed(), signature: signed().signature + "=" }).success).toBe(false)
  })
})
