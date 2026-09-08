import fixture from "./cacophony-ik.json"
import { createNoiseIk } from "./noise-ik"

// Runner-neutral assertions. Defaults preserve the same noble codec and fixture
// in daemon vitest and mobile jest-expo. Node comparison backends opt in below;
// assertions do not use either runner's matcher implementation.
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[\da-f]{2})*$/u.test(hex)) throw new Error("Invalid fixture hex")
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16))
}

function equalBytes(actual: Uint8Array, expected: string, label: string): void {
  const hex = Array.from(actual, (byte) => byte.toString(16).padStart(2, "0")).join("")
  if (hex !== expected) throw new Error(`${label}: expected ${expected}, received ${hex}`)
}

type Vector = Omit<typeof fixture, "_source">
type Factory = typeof createNoiseIk

function initiatorOptions(vector: Vector = fixture) {
  return {
    role: "initiator" as const, suite: vector.protocol_name,
    prologue: fromHex(vector.init_prologue),
    staticKey: fromHex(vector.init_static), ephemeralKey: fromHex(vector.init_ephemeral),
    responderPublicKey: fromHex(vector.init_remote_static),
  }
}

export function fixturePair(factory: Factory = createNoiseIk, vector: Vector = fixture) {
  return {
    initiator: factory(initiatorOptions(vector)),
    responder: factory({
      role: "responder", suite: vector.protocol_name,
      prologue: fromHex(vector.resp_prologue),
      staticKey: fromHex(vector.resp_static), ephemeralKey: fromHex(vector.resp_ephemeral),
    }),
  }
}

function connect(pair: ReturnType<typeof fixturePair>) {
  pair.responder.readHandshake(pair.initiator.writeHandshake(new Uint8Array()))
  pair.initiator.readHandshake(pair.responder.writeHandshake(new Uint8Array()))
  return pair
}

function rejects(operation: () => unknown): void {
  try { operation() } catch (error) {
    if (error instanceof Error && error.message === "Relay channel rejected" && error.cause === undefined) return
    throw new Error("Refusal exposed a nonuniform error", { cause: error })
  }
  throw new Error("Expected channel rejection")
}

function flipped(bytes: Uint8Array, offset = 0): Uint8Array {
  const result = bytes.slice()
  result[offset] = (result[offset] ?? 0) ^ 1
  return result
}

export function createRelayVectorCases(factory: Factory, vector: Vector, supportedSuites = [vector.protocol_name]) {
  const createNoiseIk = factory
  const fixture = vector
  const options = () => initiatorOptions(vector)
  const pair = () => fixturePair(factory, vector)
  const connectedPair = () => connect(pair())
  const publicLength = vector.init_remote_static.length / 2
  return [
    {
      name: "matches both fixture IK handshake frames and the final transcript hash",
      run() {
        const { initiator, responder } = pair()
        for (const [index, message] of fixture.messages.entries()) {
          if (index >= 2) break
          const [sender, receiver] = index === 0 ? [initiator, responder] : [responder, initiator]
          equalBytes(sender.writeHandshake(fromHex(message.payload)), message.ciphertext, `handshake ${index}`)
          equalBytes(receiver.readHandshake(fromHex(message.ciphertext)), message.payload, `payload ${index}`)
        }
        equalBytes(initiator.handshakeHash(), fixture.handshake_hash, "initiator transcript")
        equalBytes(responder.handshakeHash(), fixture.handshake_hash, "responder transcript")
      },
    },
    {
      name: "matches all four fixture transport frames, including both nonce directions",
      run() {
        const { initiator, responder } = pair()
        for (const [index, message] of fixture.messages.entries()) {
          const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator]
          const payload = fromHex(message.payload)
          const ciphertext = fromHex(message.ciphertext)
          if (index < 2) {
            sender.writeHandshake(payload)
            receiver.readHandshake(ciphertext)
          } else {
            equalBytes(sender.encrypt(payload), message.ciphertext, `transport ${index}`)
            equalBytes(receiver.decrypt(ciphertext), message.payload, `payload ${index}`)
          }
        }
      },
    },
    {
      name: "needs no ambient Buffer, text encoding, or Math.random fallback for fixed vectors",
      run() {
        // Do not remove an RNG after noble's import-time blinding probe has
        // accepted it. That models a failed RNG, not a phone starting without it.
        const keys = ["Buffer", "TextEncoder", "TextDecoder"] as const
        const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
        const random = Math.random
        try {
          for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: undefined })
          Math.random = () => { throw new Error("Insecure random fallback used") }
          // This is still the same JS engine as the runner, not a Hermes emulation.
          const { initiator, responder } = pair()
          for (const [index, message] of fixture.messages.entries()) {
            const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator]
            const payload = fromHex(message.payload)
            const packet = index < 2 ? sender.writeHandshake(payload) : sender.encrypt(payload)
            equalBytes(packet, message.ciphertext, `restricted-runtime frame ${index}`)
            equalBytes(index < 2 ? receiver.readHandshake(packet) : receiver.decrypt(packet), message.payload, "payload")
          }
        } finally {
          Math.random = random
          for (const [index, key] of keys.entries()) {
            const descriptor = descriptors[index]
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else Reflect.deleteProperty(globalThis, key)
          }
        }
      },
    },
    {
      name: "rejects low-order public keys and ciphertext copied from a different handshake",
      run() {
        const input = options()
        rejects(() => createNoiseIk({ ...input, responderPublicKey: new Uint8Array(publicLength) }).writeHandshake(new Uint8Array()))
        const first = connectedPair()
        const initiator = createNoiseIk({ ...input, ephemeralKey: flipped(input.ephemeralKey, 16) })
        const { responder } = pair()
        responder.readHandshake(initiator.writeHandshake(new Uint8Array()))
        initiator.readHandshake(responder.writeHandshake(new Uint8Array()))
        rejects(() => responder.decrypt(first.initiator.encrypt(Uint8Array.of(42))))
      },
    },
    {
      name: "keeps caller key bytes unchanged and isolates the handshake from caller mutation",
      run() {
        const input = options()
        const initiator = createNoiseIk(input)
        input.staticKey.fill(0)
        input.ephemeralKey.fill(0)
        input.responderPublicKey.fill(0)
        input.prologue.fill(0)
        equalBytes(initiator.writeHandshake(fromHex(fixture.messages[0]!.payload)), fixture.messages[0]!.ciphertext, "copied keys")
        const unchanged = options()
        const other = createNoiseIk(unchanged)
        const { responder } = pair()
        responder.readHandshake(other.writeHandshake(new Uint8Array()))
        other.readHandshake(responder.writeHandshake(new Uint8Array()))
        equalBytes(unchanged.staticKey, fixture.init_static, "caller static key")
        equalBytes(unchanged.ephemeralKey, fixture.init_ephemeral, "caller ephemeral key")
      },
    },
    {
      name: "refuses alternate suites, missing pins, and malformed keys without fallback",
      run() {
        for (const suite of ["", "Noise_XX_25519_ChaChaPoly_SHA256", "Noise_IK_25519_AESGCM_SHA256", `${fixture.protocol_name} `].filter((suite) => !supportedSuites.includes(suite))) {
          rejects(() => createNoiseIk({ ...options(), suite }))
        }
        const { responderPublicKey: _pin, ...withoutPin } = options()
        rejects(() => createNoiseIk(withoutPin))
        for (const key of ["staticKey", "ephemeralKey", "responderPublicKey"] as const) {
          const size = key === "responderPublicKey" ? publicLength : 32
          for (const length of [0, size - 1, size + 1]) {
            rejects(() => createNoiseIk({ ...options(), [key]: new Uint8Array(length) }))
          }
        }
      },
    },
    {
      name: "binds the prologue and pinned responder key to the transcript",
      run() {
        for (const field of ["prologue", "responderPublicKey"] as const) {
          const input = options()
          const { responder } = pair()
          rejects(() => {
            const initiator = createNoiseIk({ ...input, [field]: flipped(input[field]) })
            responder.readHandshake(initiator.writeHandshake(new Uint8Array()))
          })
          rejects(() => responder.writeHandshake(new Uint8Array()))
        }
      },
    },
    {
      name: "rejects corruption in every first-handshake component and keeps the channel closed",
      run() {
        const message = fromHex(fixture.messages[0]!.ciphertext)
        for (const offset of [0, publicLength, 2 * publicLength, 2 * publicLength + 16, message.length - 1]) {
          const { responder } = pair()
          rejects(() => responder.readHandshake(flipped(message, offset)))
          rejects(() => responder.readHandshake(message))
          rejects(() => responder.writeHandshake(new Uint8Array()))
        }
      },
    },
    {
      name: "rejects a corrupt handshake reply and cannot return a transport cipher",
      run() {
        for (const offset of [0, publicLength, publicLength + 15]) {
          const { initiator, responder } = pair()
          responder.readHandshake(initiator.writeHandshake(new Uint8Array()))
          const reply = responder.writeHandshake(new Uint8Array())
          rejects(() => initiator.readHandshake(flipped(reply, offset)))
          rejects(() => initiator.readHandshake(reply))
          rejects(() => initiator.encrypt(Uint8Array.of(1)))
        }
      },
    },
    {
      name: "rejects tampering, replay, reordering, and truncation, with no retry on the failed stream",
      run() {
        for (const attack of ["tamper", "replay", "reorder", "truncate"] as const) {
          for (const reverse of [false, true]) {
            const { initiator, responder } = connectedPair()
            const [sender, receiver] = reverse ? [responder, initiator] : [initiator, responder]
            const first = sender.encrypt(Uint8Array.of(42))
            const second = sender.encrypt(Uint8Array.of(43))
            if (attack === "replay") equalBytes(receiver.decrypt(first), "2a", "first delivery")
            const bad = attack === "tamper" ? flipped(first) : attack === "reorder" ? second
              : attack === "truncate" ? first.subarray(0, first.length - 1) : first
            rejects(() => receiver.decrypt(bad))
            rejects(() => receiver.decrypt(attack === "replay" ? second : first))
            rejects(() => receiver.encrypt(Uint8Array.of(44)))
          }
        }
      },
    },
    {
      name: "bounds Noise frames before cryptography and rejects invalid handshake order",
      run() {
        for (const length of [0, publicLength - 1, 2 * publicLength + 15, 2 * publicLength + 31, 65536]) {
          const { responder } = pair()
          rejects(() => responder.readHandshake(new Uint8Array(length)))
        }
        rejects(() => pair().initiator.writeHandshake(new Uint8Array(65535 - (2 * publicLength + 32) + 1)))
        rejects(() => connectedPair().initiator.encrypt(new Uint8Array(65535 - 16 + 1)))
        rejects(() => connectedPair().responder.decrypt(new Uint8Array(65536)))
        rejects(() => pair().responder.writeHandshake(new Uint8Array()))
        rejects(() => pair().initiator.encrypt(Uint8Array.of(1)))
        rejects(() => pair().responder.decrypt(new Uint8Array(16)))
      },
    },
    {
      name: "only emits ciphertext for fixture bearers, RPC, terminal bytes, and error text",
      run() {
        const { initiator, responder } = pair()
        const frames = [initiator.writeHandshake(new Uint8Array())]
        responder.readHandshake(frames[0]!)
        frames.push(responder.writeHandshake(new Uint8Array()))
        initiator.readHandshake(frames[1]!)
        // Synthetic fixture secrets. Never use real credentials in this proof.
        const text = '{"jsonrpc":"2.0","method":"session.send","bearer":"fixture-device-bearer","error":"fixture-private-error"}'
        const payload = Uint8Array.from(text, (letter) => letter.charCodeAt(0))
        frames.push(initiator.encrypt(payload))
        equalBytes(responder.decrypt(frames[2]!), Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join(""), "RPC")
        // UTF-8 terminal bytes for π🔒 and arbitrary binary bytes travel unchanged.
        const terminal = fromHex("1b5b33326dcf80f09f949200ff")
        frames.push(responder.encrypt(terminal))
        equalBytes(initiator.decrypt(frames[3]!), "1b5b33326dcf80f09f949200ff", "terminal")
        const hidden = [fixture.init_static, fixture.resp_static, fixture.init_ephemeral, fixture.resp_ephemeral,
          ...[text, "fixture-device-bearer", "fixture-private-error"].map((value) =>
            Array.from(value, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")),
          "1b5b33326dcf80f09f949200ff"]
        for (const frame of frames) {
          const hex = Array.from(frame, (b) => b.toString(16).padStart(2, "0")).join("")
          if (hidden.some((secret) => hex.includes(secret))) throw new Error("Fixture secret crossed the frame boundary")
        }
      },
    },
  ]
}

export const relayVectorCases = createRelayVectorCases(createNoiseIk, fixture)
