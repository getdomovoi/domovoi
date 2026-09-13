import { describe, expect, it } from "vitest"
import { createNoiseIk, relayNoiseSuite } from "../index"
import type { NoiseIkOptions } from "../index"
import { CipherState } from "../noise-ik"
import { createNodeNoiseIk } from "./node-noise-ik"
import { NodeCipherState, privateKey, publicBytes } from "./node-primitives"
import { fixturePair, fromHex, relayVectorCases } from "./vector-cases"
import fixture from "./cacophony-ik.json"

const empty = new Uint8Array()
const responderOptions: NoiseIkOptions = {
  role: "responder", suite: relayNoiseSuite, prologue: empty,
  staticKey: fromHex(fixture.resp_static), ephemeralKey: fromHex(fixture.resp_ephemeral),
}

describe("frozen suite-A codec", () => {
  for (const test of relayVectorCases) it(test.name, test.run)

  it("returns the authenticated peer key after completion, as an isolated copy", () => {
    const { initiator, responder } = fixturePair()
    responder.readHandshake(initiator.writeHandshake(empty))
    initiator.readHandshake(responder.writeHandshake(empty))
    expect(initiator.remoteStaticKey()).toEqual(fromHex(fixture.init_remote_static))
    const clientPublic = publicBytes(privateKey(fromHex(fixture.init_static)))
    expect(responder.remoteStaticKey()).toEqual(clientPublic)
    for (const peer of [initiator, responder]) {
      const expected = new Uint8Array(peer.remoteStaticKey())
      peer.remoteStaticKey().fill(0)
      expect(peer.remoteStaticKey()).toEqual(expected)
      expect(() => peer.decrypt(new Uint8Array(16))).toThrow("Relay channel rejected")
      expect(() => peer.remoteStaticKey()).toThrow("Relay channel rejected")
    }
  })

  it("refuses peer identity before handshake completion", () => {
    for (const peer of [fixturePair().initiator, fixturePair().responder]) {
      expect(() => peer.remoteStaticKey()).toThrow("Relay channel rejected")
      expect(() => peer.writeHandshake(empty)).toThrow("Relay channel rejected")
    }
    const pair = fixturePair()
    pair.responder.readHandshake(pair.initiator.writeHandshake(empty))
    expect(() => pair.responder.remoteStaticKey()).toThrow("Relay channel rejected")
    expect(() => pair.responder.writeHandshake(empty)).toThrow("Relay channel rejected")
  })

  it("validates constructor inputs at runtime and conceals primitive failures", () => {
    for (const input of [null, undefined, {}, { ...responderOptions, role: "server" },
      { ...responderOptions, prologue: new Uint8Array(65536) },
      { ...responderOptions, prologue: "" },
      { ...responderOptions, staticKey: new Array(32).fill(1) },
      { ...responderOptions, responderPublicKey: new Uint8Array(32) },
    ]) {
      let caught: unknown
      try { createNoiseIk(input as NoiseIkOptions) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe("Relay channel rejected")
      expect((caught as Error).cause).toBeUndefined()
    }
  })

  it("bounds each handshake and transport direction at the exact Noise maximum", () => {
    const { initiator, responder } = fixturePair()
    for (const [sender, receiver, overhead] of [[initiator, responder, 96], [responder, initiator, 48]] as const) {
      const payload = new Uint8Array(65535 - overhead).fill(73)
      const frame = sender.writeHandshake(payload)
      expect(frame.length).toBe(65535)
      expect(receiver.readHandshake(frame)).toEqual(payload)
    }
    for (const [sender, receiver] of [[initiator, responder], [responder, initiator]] as const) {
      const payload = new Uint8Array(65519).fill(173)
      const frame = sender.encrypt(payload)
      expect(frame.length).toBe(65535)
      expect(receiver.decrypt(frame)).toEqual(payload)
    }
    const second = fixturePair()
    second.responder.readHandshake(second.initiator.writeHandshake(empty))
    expect(() => second.responder.writeHandshake(new Uint8Array(65535 - 48 + 1))).toThrow("Relay channel rejected")
    expect(() => second.responder.writeHandshake(empty)).toThrow("Relay channel rejected")
  })

  it("makes invalid order and non-byte input terminal for both roles", () => {
    for (const operation of [
      (pair: ReturnType<typeof fixturePair>) => pair.initiator.readHandshake(new Uint8Array(48)),
      (pair: ReturnType<typeof fixturePair>) => pair.initiator.handshakeHash(),
      (pair: ReturnType<typeof fixturePair>) => pair.initiator.writeHandshake(null as unknown as Uint8Array),
    ]) {
      const pair = fixturePair()
      expect(() => operation(pair)).toThrow("Relay channel rejected")
      expect(() => pair.initiator.writeHandshake(empty)).toThrow("Relay channel rejected")
    }
    const pair = fixturePair()
    pair.responder.readHandshake(pair.initiator.writeHandshake(empty))
    pair.initiator.readHandshake(pair.responder.writeHandshake(empty))
    expect(pair.responder.handshakeHash()).toEqual(pair.initiator.handshakeHash())
    expect(() => pair.responder.readHandshake(new Uint8Array(96))).toThrow("Relay channel rejected")
    expect(() => pair.responder.encrypt(empty)).toThrow("Relay channel rejected")
    expect(() => pair.initiator.writeHandshake(empty)).toThrow("Relay channel rejected")
    expect(() => pair.initiator.decrypt(new Uint8Array(16))).toThrow("Relay channel rejected")
  })

  for (const reverse of [false, true]) {
    it(`interoperates with the test-only Node oracle, noble initiator=${!reverse}`, () => {
      const initiator = fixturePair(reverse ? createNodeNoiseIk : createNoiseIk).initiator
      const responder = fixturePair(reverse ? createNoiseIk : createNodeNoiseIk).responder
      for (const [index, message] of fixture.messages.entries()) {
        const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator]
        const payload = fromHex(message.payload)
        const frame = index < 2 ? sender.writeHandshake(payload) : sender.encrypt(payload)
        expect(new Uint8Array(frame)).toEqual(fromHex(message.ciphertext))
        expect(new Uint8Array(index < 2 ? receiver.readHandshake(frame) : receiver.decrypt(frame))).toEqual(payload)
      }
    })
  }
})

describe("suite-A nonce contract", () => {
  for (const nonce of [0n, 1n, 0xffffffffn, 0x100000000n, 0xfffffffffffffffen]) {
    it(`uses the complete little-endian counter at ${nonce}`, () => {
      const sender = new CipherState(new Uint8Array(32))
      const oracle = new NodeCipherState(new Uint8Array(32))
      sender.nonce = oracle.nonce = nonce
      const frame = sender.crypt(Uint8Array.of(42), empty, false)
      expect(frame).toEqual(new Uint8Array(oracle.crypt(Uint8Array.of(42), empty, false)))
      expect(sender.nonce).toBe(nonce + 1n)
      const receiver = new CipherState(new Uint8Array(32))
      receiver.nonce = nonce
      expect(receiver.crypt(frame, empty, true)).toEqual(Uint8Array.of(42))
      expect(receiver.nonce).toBe(nonce + 1n)
    })
  }

  it("refuses the reserved maximum and advances only after authentication", () => {
    const state = new CipherState(new Uint8Array(32))
    expect(() => state.crypt(new Uint8Array(16), empty, true)).toThrow()
    expect(state.nonce).toBe(0n)
    state.nonce = 0xfffffffffffffffen
    state.crypt(empty, empty, false)
    for (const nonce of [-1n, 0xffffffffffffffffn, 0x10000000000000000n]) {
      state.nonce = nonce
      expect(() => state.crypt(empty, empty, false)).toThrow("Relay channel rejected")
      expect(() => state.crypt(new Uint8Array(16), empty, true)).toThrow("Relay channel rejected")
      expect(state.nonce).toBe(nonce)
    }
  })
})
