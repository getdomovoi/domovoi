import { describe, expect, it } from "vitest"
import { createPublicKey, generateKeyPairSync } from "node:crypto"

import fixture from "../../../packages/protocol/experimental/relay/cacophony-ik.json"
import aesFixture from "../../../packages/protocol/experimental/relay/cacophony-ik-aesgcm.json"
import p256Fixture from "../../../packages/protocol/experimental/relay/cacophony-derived-p256.json"
import { createNodeNoiseIk } from "../../../packages/protocol/experimental/relay/node-noise-ik"
import { createRelayVectorCases } from "../../../packages/protocol/experimental/relay/vector-cases"
import { generatePrivateKey, nodeSuites, NodeCipherState, publicBytes } from "../../../packages/protocol/experimental/relay/node-primitives"

const suites = [fixture, aesFixture, p256Fixture].map((vector) => vector.protocol_name)
for (const vector of [fixture, aesFixture, p256Fixture]) {
  describe(`experimental node:crypto ${vector.protocol_name}`, () => {
    for (const test of createRelayVectorCases(createNodeNoiseIk, vector, suites)) it(test.name, test.run)
  })
}

describe("experimental Node crypto Noise backend", () => {
  it("reproduces the published option A first handshake through node:crypto", () => {
    const peer = createNodeNoiseIk({
      role: "initiator", suite: fixture.protocol_name,
      staticKey: Buffer.from(fixture.init_static, "hex"),
      ephemeralKey: Buffer.from(fixture.init_ephemeral, "hex"),
      responderPublicKey: Buffer.from(fixture.init_remote_static, "hex"),
      prologue: Buffer.from(fixture.init_prologue, "hex"),
    })
    expect(Buffer.from(peer.writeHandshake(Buffer.from(fixture.messages[0]!.payload, "hex"))).toString("hex"))
      .toBe(fixture.messages[0]!.ciphertext)
  })

  for (const suite of nodeSuites) {
    it(`${suite.name} completes with generated native KeyObjects and maximum frames`, () => {
      const staticKey = generatePrivateKey(suite)
      const pin = publicBytes(suite, staticKey)
      const initiator = createNodeNoiseIk({ role: "initiator", suite: suite.name,
        prologue: new Uint8Array(), staticKey: generatePrivateKey(suite),
        ephemeralKey: generatePrivateKey(suite), responderPublicKey: pin })
      const responder = createNodeNoiseIk({ role: "responder", suite: suite.name,
        prologue: new Uint8Array(), staticKey, ephemeralKey: generatePrivateKey(suite) })
      const first = initiator.writeHandshake(new Uint8Array())
      expect(first.length).toBe(2 * suite.publicLength + 32)
      expect(responder.readHandshake(first).length).toBe(0)
      const second = responder.writeHandshake(new Uint8Array())
      expect(second.length).toBe(suite.publicLength + 16)
      expect(initiator.readHandshake(second).length).toBe(0)
      expect(initiator.handshakeHash()).toEqual(responder.handshakeHash())
      const payload = new Uint8Array(65519).fill(173)
      for (const [sender, receiver] of [[initiator, responder], [responder, initiator]] as const) {
        expect(Buffer.from(receiver.decrypt(sender.encrypt(payload))).equals(payload)).toBe(true)
      }
      // The codec releases its references; it cannot destroy the caller's key.
      expect(publicBytes(suite, staticKey)).toEqual(pin)
    })

    it(`${suite.name} rejects unsuitable KeyObjects and a valid but incorrect responder pin`, () => {
      const options = { role: "initiator" as const, suite: suite.name, prologue: new Uint8Array(),
        staticKey: generatePrivateKey(suite), ephemeralKey: generatePrivateKey(suite),
        responderPublicKey: publicBytes(suite, generatePrivateKey(suite)) }
      for (const key of [createPublicKey(options.staticKey), generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey]) {
        expect(() => createNodeNoiseIk({ ...options, staticKey: key })).toThrow("Relay channel rejected")
        expect(() => createNodeNoiseIk({ ...options, ephemeralKey: key })).toThrow("Relay channel rejected")
      }
      const initiator = createNodeNoiseIk(options)
      const responder = createNodeNoiseIk({ role: "responder", suite: suite.name, prologue: new Uint8Array(),
        staticKey: generatePrivateKey(suite), ephemeralKey: generatePrivateKey(suite) })
      expect(() => responder.readHandshake(initiator.writeHandshake(new Uint8Array()))).toThrow("Relay channel rejected")
      expect(() => responder.writeHandshake(new Uint8Array())).toThrow("Relay channel rejected")
    })

    it(`${suite.name} carries a 64-bit nonce and refuses its reserved maximum`, () => {
      const sender = new NodeCipherState(suite, new Uint8Array(32))
      const receiver = new NodeCipherState(suite, new Uint8Array(32))
      sender.nonce = receiver.nonce = 0x100000000n
      const ciphertext = sender.crypt(Uint8Array.of(42), new Uint8Array(), false)
      expect(Buffer.from(receiver.crypt(ciphertext, new Uint8Array(), true)).toString("hex")).toBe("2a")
      expect(sender.nonce).toBe(0x100000001n)
      sender.nonce = 0xfffffffffffffffen
      sender.crypt(new Uint8Array(), new Uint8Array(), false)
      expect(() => sender.crypt(new Uint8Array(), new Uint8Array(), false)).toThrow("Relay channel rejected")
    })
  }
})
