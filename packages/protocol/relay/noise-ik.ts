// Frozen suite-A Noise revision 34 IK composition. See README.md and
// docs/relay-wire-format.md for the byte contract and integration limits.
// External review is pending. This codec does not generate or store keys.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"

export const relayNoiseSuite = "Noise_IK_25519_ChaChaPoly_SHA256"
const empty = new Uint8Array()
const maxFrame = 65535

function reject(): never { throw new Error("Relay channel rejected") }

function bound(bytes: Uint8Array, min: number, max: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) reject()
}

export type NoiseIkOptions = {
  role: "initiator" | "responder"
  suite: string
  prologue: Uint8Array
  staticKey: Uint8Array
  ephemeralKey: Uint8Array
  responderPublicKey?: Uint8Array
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

// Noise HKDF with two outputs (section 4.3). No string or runtime text codec.
function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temporaryKey = hmac(sha256, chainingKey, input)
  const first = hmac(sha256, temporaryKey, Uint8Array.of(1))
  const second = hmac(sha256, temporaryKey, concat(first, Uint8Array.of(2)))
  temporaryKey.fill(0)
  return [first, second]
}

// Internal test seam, deliberately absent from the package entry point.
export class CipherState {
  nonce = 0n
  constructor(readonly key: Uint8Array) {}

  crypt(input: Uint8Array, ad: Uint8Array, decrypt: boolean): Uint8Array {
    if (this.nonce < 0n || this.nonce >= 0xffffffffffffffffn) reject()
    const nonce = new Uint8Array(12)
    const view = new DataView(nonce.buffer)
    view.setUint32(4, Number(this.nonce & 0xffffffffn), true)
    view.setUint32(8, Number(this.nonce >> 32n), true)
    const cipher = chacha20poly1305(this.key, nonce, ad)
    const result = decrypt ? cipher.decrypt(input) : cipher.encrypt(input)
    this.nonce += 1n
    return result
  }
}

export function createNoiseIk(options: NoiseIkOptions) {
  try {
    if (options.suite !== relayNoiseSuite || !["initiator", "responder"].includes(options.role)) reject()
    bound(options.staticKey, 32, 32)
    bound(options.ephemeralKey, 32, 32)
    bound(options.prologue, 0, maxFrame)
    if (options.role === "initiator") bound(options.responderPublicKey ?? empty, 32, 32)
    else if (options.responderPublicKey !== undefined) reject()
    return handshake(options)
  } catch { return reject() }
}

function handshake(options: NoiseIkOptions) {
  const initiator = options.role === "initiator"
  const staticKey = new Uint8Array(options.staticKey)
  const ephemeralKey = new Uint8Array(options.ephemeralKey)
  const publicStatic = x25519.getPublicKey(staticKey)
  const publicEphemeral = x25519.getPublicKey(ephemeralKey)
  let remoteStatic: Uint8Array | undefined = initiator && options.responderPublicKey ? new Uint8Array(options.responderPublicKey) : undefined
  let remoteEphemeral: Uint8Array | undefined
  // This suite's name is exactly HASHLEN bytes. InitializeSymmetric uses
  // it verbatim, hashing only names longer than HASHLEN (Noise section 5.2).
  let hash: Uint8Array = Uint8Array.from(relayNoiseSuite, (letter) => letter.charCodeAt(0))
  let chainingKey: Uint8Array = hash.slice()
  let cipher: CipherState | undefined
  let sendCipher: CipherState | undefined
  let receiveCipher: CipherState | undefined
  let step = 0
  let closed = false

  function guarded(operation: () => Uint8Array): Uint8Array {
    if (closed) reject()
    try { return operation() } catch {
      // A failed ordered stream has no resynchronization or fallback. Both
      // directions are terminal, even if the next packet would authenticate.
      closed = true
      staticKey.fill(0)
      ephemeralKey.fill(0)
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
    cipher = new CipherState(key)
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
    sendCipher = new CipherState(initiator ? first : second)
    receiveCipher = new CipherState(initiator ? second : first)
    staticKey.fill(0)
    ephemeralKey.fill(0)
    chainingKey.fill(0)
    cipher?.key.fill(0)
    cipher = undefined
  }

  mixHash(options.prologue)
  mixHash(initiator ? remoteStatic ?? empty : publicStatic)

  return {
    writeHandshake(payload: Uint8Array): Uint8Array {
      return guarded(() => {
        bound(payload, 0, maxFrame - (initiator ? 96 : 48))
        if (initiator && step === 0 && remoteStatic) {
          mixHash(publicEphemeral) // -> e, es, s, ss
          mixKey(x25519.getSharedSecret(ephemeralKey, remoteStatic))
          const encryptedStatic = encryptAndHash(publicStatic)
          mixKey(x25519.getSharedSecret(staticKey, remoteStatic))
          const frame = concat(publicEphemeral, encryptedStatic, encryptAndHash(payload))
          step = 1
          return frame
        }
        if (!initiator && step === 1 && remoteEphemeral && remoteStatic) {
          mixHash(publicEphemeral) // <- e, ee, se
          mixKey(x25519.getSharedSecret(ephemeralKey, remoteEphemeral))
          mixKey(x25519.getSharedSecret(ephemeralKey, remoteStatic))
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
        bound(message, initiator ? 48 : 96, maxFrame)
        if (!initiator && step === 0) {
          remoteEphemeral = new Uint8Array(message.subarray(0, 32))
          mixHash(remoteEphemeral)
          mixKey(x25519.getSharedSecret(staticKey, remoteEphemeral))
          remoteStatic = decryptAndHash(message.subarray(32, 80))
          mixKey(x25519.getSharedSecret(staticKey, remoteStatic))
          const payload = decryptAndHash(message.subarray(80))
          step = 1
          return payload
        }
        if (initiator && step === 1) {
          remoteEphemeral = new Uint8Array(message.subarray(0, 32))
          mixHash(remoteEphemeral)
          mixKey(x25519.getSharedSecret(ephemeralKey, remoteEphemeral))
          mixKey(x25519.getSharedSecret(staticKey, remoteEphemeral))
          const payload = decryptAndHash(message.subarray(32))
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
        return hash.slice()
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
