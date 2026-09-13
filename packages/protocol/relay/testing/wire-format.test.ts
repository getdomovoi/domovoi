import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createNoiseIk } from "../index"
import { CipherState } from "../noise-ik"
import { createNodeNoiseIk } from "./node-noise-ik"
import { NodeCipherState } from "./node-primitives"
import { fromHex } from "./vector-cases"
import frames from "./wire-frames.json"
import layout from "./wire-layout.json"

const empty = new Uint8Array()
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"))
const payload = (record: { repeatByte: number; length: number }) => new Uint8Array(record.length).fill(record.repeatByte)

describe("frozen relay frame layout", () => {
  it("pins message 1: ephemeral 0..32, encrypted static 32..80, payload from 80, overhead 96", () => {
    expect(layout.message1).toEqual({ ephemeral: [0, 32], encryptedStatic: [32, 80], payloadStart: 80, overheadBytes: 96 })
  })

  it("pins message 2: ephemeral 0..32, payload from 32, overhead 48", () => {
    expect(layout.message2).toEqual({ ephemeral: [0, 32], payloadStart: 32, overheadBytes: 48 })
  })

  it("pins 16-byte tags, 65535-byte frames and little-endian nonce bytes 4..12", () => {
    expect(layout.format).toBe("domovoi.relay.wire-layout.v1")
    expect(layout.tagBytes).toBe(16)
    expect(layout.maximumFrameBytes).toBe(65535)
    expect(layout.nonce).toEqual({ bytes: 12, zeroPrefix: [0, 4], counter: [4, 12], byteOrder: "little" })
  })

  it("matches the static fixture digests recorded in the freeze document", () => {
    const doc = readFileSync(new URL("../../../../docs/relay-wire-format.md", import.meta.url), "utf8")
    for (const name of ["wire-layout.json", "wire-frames.json"]) {
      const recorded = doc.split("\n").find((line) => line.startsWith(`- \`${name}\`: \`sha256:`))
      expect(recorded, `Missing recorded digest for ${name}`).toBeDefined()
      const expected = recorded?.match(/sha256:([a-f0-9]{64})/u)?.[1]
      expect(expected).toBeDefined()
      const actual = createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")
      expect(actual).toBe(expected)
    }
  })
})

for (const [backend, factory] of [["noble", createNoiseIk], ["Node comparison", createNodeNoiseIk]] as const) {
  describe(`${backend} reads recorded wire frames`, () => {
    for (const connection of frames.connections) {
      it(`${connection.name}: pins every handshake and transport byte, field boundary and tag`, () => {
        expect(frames.format).toBe("domovoi.relay.wire-frames.v1")
        expect(frames.suite).toBe("Noise_IK_25519_ChaChaPoly_SHA256")
        const { keys } = connection
        const prologue = fromHex(connection.prologueHex)
        const initiator = factory({ role: "initiator", suite: frames.suite, prologue,
          staticKey: fromHex(keys.initiatorStatic), ephemeralKey: fromHex(keys.initiatorEphemeral),
          responderPublicKey: fromHex(keys.responderPublic) })
        const responder = factory({ role: "responder", suite: frames.suite, prologue,
          staticKey: fromHex(keys.responderStatic), ephemeralKey: fromHex(keys.responderEphemeral) })
        for (const [index, message] of connection.messages.entries()) {
          expect(message.phase).toBe(index < 2 ? "handshake" : "transport")
          expect(message.sender).toBe(index % 2 === 0 ? "initiator" : "responder")
          const [sender, receiver] = message.sender === "initiator" ? [initiator, responder] : [responder, initiator]
          const clear = payload(message.payload)
          const expected = bytes(message.ciphertextBase64)
          const actual = new Uint8Array(index < 2 ? sender.writeHandshake(clear) : sender.encrypt(clear))
          expect(actual).toEqual(expected)
          expect(actual.length).toBeLessThanOrEqual(layout.maximumFrameBytes)
          if (index < 2) {
            const fields = index === 0 ? layout.message1 : layout.message2
            const peerKey = index === 0 ? keys.initiatorEphemeralPublic : keys.responderEphemeralPublic
            expect(actual.subarray(fields.ephemeral[0], fields.ephemeral[1])).toEqual(fromHex(peerKey))
            expect(actual.length - clear.length).toBe(fields.overheadBytes)
            expect(actual.subarray(fields.payloadStart).length).toBe(clear.length + layout.tagBytes)
            if (index === 0) {
              const [start, end] = layout.message1.encryptedStatic
              expect(actual.subarray(start, end)).toEqual(expected.subarray(start, end))
              expect(actual.subarray(start, end).length).toBe(fromHex(keys.initiatorPublic).length + layout.tagBytes)
            }
          } else {
            expect(actual.length - clear.length).toBe(layout.tagBytes)
          }
          expect(new Uint8Array(index < 2 ? receiver.readHandshake(expected) : receiver.decrypt(expected))).toEqual(clear)
        }
        for (const peer of [initiator, responder]) expect(peer.handshakeHash()).toEqual(fromHex(connection.handshakeHash))
        expect(initiator.remoteStaticKey()).toEqual(fromHex(keys.responderPublic))
        expect(responder.remoteStaticKey()).toEqual(fromHex(keys.initiatorPublic))
        expect(() => initiator.encrypt(new Uint8Array(layout.maximumFrameBytes - layout.tagBytes + 1)))
          .toThrow("Relay channel rejected")
        expect(() => responder.decrypt(new Uint8Array(layout.maximumFrameBytes + 1))).toThrow("Relay channel rejected")
      })
    }
  })
}

describe("recorded nonce bytes", () => {
  for (const item of frames.nonceCases) {
    it(`${item.counter}: counter occupies little-endian bytes 4..12 after four zeros`, () => {
      const nonce = fromHex(item.nonceHex)
      expect(nonce.length).toBe(layout.nonce.bytes)
      expect(nonce.subarray(layout.nonce.zeroPrefix[0], layout.nonce.zeroPrefix[1])).toEqual(new Uint8Array(4))
      const littleEndian = BigInt(item.counter).toString(16).padStart(16, "0").match(/../gu)!.reverse().join("")
      expect(nonce.subarray(layout.nonce.counter[0], layout.nonce.counter[1])).toEqual(fromHex(littleEndian))
      for (const Factory of [CipherState, NodeCipherState]) {
        const sender = new Factory(fromHex(item.keyHex))
        sender.nonce = BigInt(item.counter)
        expect(new Uint8Array(sender.crypt(fromHex(item.payloadHex), empty, false))).toEqual(bytes(item.ciphertextBase64))
        const receiver = new Factory(fromHex(item.keyHex))
        receiver.nonce = BigInt(item.counter)
        expect(new Uint8Array(receiver.crypt(bytes(item.ciphertextBase64), empty, true))).toEqual(fromHex(item.payloadHex))
      }
    })
  }
})
