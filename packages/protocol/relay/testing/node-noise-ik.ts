// Test-only suite-A comparison oracle. Never exported or selected at runtime.
// KeyObjects here are exportable OpenSSL keys. Dropping references cannot promise
// immediate native-memory erasure or establish OS-protected private-key custody.
import type { KeyObject } from "node:crypto"
import type { NoiseIkOptions } from "../noise-ik"
import { bound, concat, dh, hmac, nodeSuite, NodeCipherState, peerKey, privateKey, publicBytes, reject, sha256 } from "./node-primitives"
import type { NodeSuite } from "./node-primitives"

export type NodeNoiseIkOptions = Omit<NoiseIkOptions, "staticKey" | "ephemeralKey"> & {
  staticKey: Uint8Array | KeyObject
  ephemeralKey: Uint8Array | KeyObject
}
const empty = new Uint8Array()
const maxFrame = 65535

function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temporaryKey = hmac(chainingKey, input)
  const first = hmac(temporaryKey, Uint8Array.of(1))
  const second = hmac(temporaryKey, concat(first, Uint8Array.of(2)))
  temporaryKey.fill(0)
  return [first, second]
}

export function createNodeNoiseIk(options: NodeNoiseIkOptions) {
  try {
    const suite = nodeSuite(options.suite)
    if (!["initiator", "responder"].includes(options.role)) reject()
    bound(options.prologue, 0, maxFrame)
    if (options.role === "initiator") bound(options.responderPublicKey ?? empty, suite.publicLength, suite.publicLength)
    else if (options.responderPublicKey !== undefined) reject()
    return handshake(options, suite)
  } catch { return reject() }
}

function handshake(options: NodeNoiseIkOptions, suite: NodeSuite) {
  const initiator = options.role === "initiator"
  let staticKey: KeyObject | undefined = privateKey(options.staticKey)
  let ephemeralKey: KeyObject | undefined = privateKey(options.ephemeralKey)
  const publicStatic = publicBytes(staticKey)
  const publicEphemeral = publicBytes(ephemeralKey)
  const publicLength = suite.publicLength
  let remoteStatic: Uint8Array | undefined = initiator && options.responderPublicKey ? new Uint8Array(options.responderPublicKey) : undefined
  let remoteEphemeral: Uint8Array | undefined
  if (remoteStatic) peerKey(remoteStatic)
  // Names shorter than HASHLEN are zero-padded, not hashed (Noise 5.2).
  const name = Uint8Array.from(suite.name, (letter) => letter.charCodeAt(0))
  let hash: Uint8Array = name.length > 32 ? sha256(name) : new Uint8Array(32)
  if (name.length <= 32) hash.set(name)
  let chainingKey: Uint8Array = new Uint8Array(hash)
  let cipher: NodeCipherState | undefined
  let sendCipher: NodeCipherState | undefined
  let receiveCipher: NodeCipherState | undefined
  let step = 0
  let closed = false

  function guarded(operation: () => Uint8Array): Uint8Array {
    if (closed) reject()
    try { return operation() } catch {
      // A failed ordered stream has no resynchronization or fallback. Both
      // directions are terminal, even if the next packet would authenticate.
      closed = true
      staticKey = undefined
      ephemeralKey = undefined
      chainingKey.fill(0)
      cipher?.key.fill(0)
      sendCipher?.key.fill(0)
      receiveCipher?.key.fill(0)
      return reject()
    }
  }

  function mixHash(input: Uint8Array): void { hash = sha256(concat(hash, input)) }
  function mixKey(secret: Uint8Array): void {
    const [next, key] = hkdf(chainingKey, secret)
    chainingKey.fill(0)
    secret.fill(0)
    chainingKey = next
    cipher?.key.fill(0)
    cipher = new NodeCipherState(key)
  }
  function encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!cipher) throw new Error("Missing handshake cipher")
    const ciphertext = cipher.crypt(plaintext, hash, false)
    mixHash(ciphertext)
    return ciphertext
  }
  function decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!cipher) throw new Error("Missing handshake cipher")
    const plaintext = cipher.crypt(ciphertext, hash, true)
    mixHash(ciphertext)
    return plaintext
  }
  function split(): void {
    const [first, second] = hkdf(chainingKey, empty)
    sendCipher = new NodeCipherState(initiator ? first : second)
    receiveCipher = new NodeCipherState(initiator ? second : first)
    staticKey = undefined
    ephemeralKey = undefined
    chainingKey.fill(0)
    cipher?.key.fill(0)
    cipher = undefined
  }

  mixHash(options.prologue)
  mixHash(initiator ? remoteStatic ?? empty : publicStatic)

  return {
    writeHandshake(payload: Uint8Array): Uint8Array {
      return guarded(() => {
        bound(payload, 0, maxFrame - (initiator ? 2 * publicLength + 32 : publicLength + 16))
        if (initiator && step === 0 && remoteStatic) {
          mixHash(publicEphemeral) // -> e, es, s, ss
          mixKey(dh(ephemeralKey, remoteStatic))
          const encryptedStatic = encryptAndHash(publicStatic)
          mixKey(dh(staticKey, remoteStatic))
          const frame = concat(publicEphemeral, encryptedStatic, encryptAndHash(payload))
          step = 1
          return frame
        }
        if (!initiator && step === 1 && remoteEphemeral && remoteStatic) {
          mixHash(publicEphemeral) // <- e, ee, se
          mixKey(dh(ephemeralKey, remoteEphemeral))
          mixKey(dh(ephemeralKey, remoteStatic))
          const frame = concat(publicEphemeral, encryptAndHash(payload))
          step = 2
          split()
          return frame
        }
        throw new Error("Unexpected handshake write")
      })
    },
    readHandshake(message: Uint8Array): Uint8Array {
      return guarded(() => {
        bound(message, initiator ? publicLength + 16 : 2 * publicLength + 32, maxFrame)
        if (!initiator && step === 0) {
          remoteEphemeral = new Uint8Array(message.subarray(0, publicLength))
          mixHash(remoteEphemeral)
          mixKey(dh(staticKey, remoteEphemeral))
          remoteStatic = decryptAndHash(message.subarray(publicLength, 2 * publicLength + 16))
          mixKey(dh(staticKey, remoteStatic))
          const payload = decryptAndHash(message.subarray(2 * publicLength + 16))
          step = 1
          return payload
        }
        if (initiator && step === 1) {
          remoteEphemeral = new Uint8Array(message.subarray(0, publicLength))
          mixHash(remoteEphemeral)
          mixKey(dh(ephemeralKey, remoteEphemeral))
          mixKey(dh(staticKey, remoteEphemeral))
          const payload = decryptAndHash(message.subarray(publicLength))
          step = 2
          split()
          return payload
        }
        throw new Error("Unexpected handshake read")
      })
    },
    remoteStaticKey(): Uint8Array {
      return guarded(() => {
        if (step !== 2 || !remoteStatic) reject()
        return new Uint8Array(remoteStatic)
      })
    },
    handshakeHash(): Uint8Array {
      return guarded(() => {
        if (step !== 2) reject()
        return new Uint8Array(hash)
      })
    },
    encrypt(payload: Uint8Array): Uint8Array {
      return guarded(() => {
        bound(payload, 0, maxFrame - 16)
        if (!sendCipher) reject()
        return sendCipher.crypt(payload, empty, false)
      })
    },
    decrypt(message: Uint8Array): Uint8Array {
      return guarded(() => {
        bound(message, 16, maxFrame)
        if (!receiveCipher) reject()
        return receiveCipher.crypt(message, empty, true)
      })
    },
  }
}
