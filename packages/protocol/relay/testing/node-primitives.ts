// Test oracle only. Node KeyObjects are exportable software keys. This file is
// absent from the published build and is never a runtime backend selection.
import { Buffer } from "node:buffer"
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey,
  createPublicKey, diffieHellman, generateKeyPairSync, KeyObject,
} from "node:crypto"

const suiteA = { name: "Noise_IK_25519_ChaChaPoly_SHA256", publicLength: 32 } as const
export type NodeSuite = typeof suiteA

export function reject(): never { throw new Error("Relay channel rejected") }

export function nodeSuite(name: string): NodeSuite {
  return name === suiteA.name ? suiteA : reject()
}

export function bound(bytes: Uint8Array, min: number, max: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) reject()
}

export function concat(...parts: Uint8Array[]): Uint8Array { return Buffer.concat(parts) }
export function sha256(bytes: Uint8Array): Uint8Array { return createHash("sha256").update(bytes).digest() }
export function hmac(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  return createHmac("sha256", key).update(bytes).digest()
}

export function generatePrivateKey(): KeyObject { return generateKeyPairSync("x25519").privateKey }

function validatePrivate(key: KeyObject): KeyObject {
  if (key.type !== "private" || key.asymmetricKeyType !== "x25519") reject()
  return key
}

export function privateKey(input: Uint8Array | KeyObject): KeyObject {
  if (input instanceof KeyObject) return validatePrivate(input)
  bound(input, 32, 32)
  // PKCS8 encoding of the published X25519 fixture scalar.
  const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), input])
  try {
    return validatePrivate(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
  } finally { der.fill(0) }
}

export function publicBytes(key: KeyObject): Uint8Array {
  validatePrivate(key)
  const der = createPublicKey(key).export({ format: "der", type: "spki" })
  return new Uint8Array(der.subarray(-32))
}

export function peerKey(bytes: Uint8Array): KeyObject {
  bound(bytes, 32, 32)
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), bytes]), format: "der", type: "spki" })
}

export function dh(own: KeyObject | undefined, peer: Uint8Array): Uint8Array {
  if (!own) reject()
  const result = diffieHellman({ privateKey: own, publicKey: peerKey(peer) })
  if (result.length !== 32 || result.every((byte) => byte === 0)) reject()
  return result
}

export class NodeCipherState {
  nonce = 0n
  constructor(readonly key: Uint8Array) {}

  crypt(input: Uint8Array, ad: Uint8Array, decrypt: boolean): Uint8Array {
    if (this.nonce < 0n || this.nonce >= 0xffffffffffffffffn) reject()
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64LE(this.nonce, 4)
    let result: Uint8Array
    if (decrypt) {
      bound(input, 16, 65535)
      const cipher = createDecipheriv("chacha20-poly1305", this.key, nonce, { authTagLength: 16 })
      cipher.setAAD(ad)
      cipher.setAuthTag(input.subarray(-16))
      const plaintext = cipher.update(input.subarray(0, -16))
      try { result = concat(plaintext, cipher.final()) } finally { plaintext.fill(0) }
    } else {
      const cipher = createCipheriv("chacha20-poly1305", this.key, nonce, { authTagLength: 16 })
      cipher.setAAD(ad)
      result = concat(cipher.update(input), cipher.final(), cipher.getAuthTag())
    }
    this.nonce += 1n
    return result
  }
}
