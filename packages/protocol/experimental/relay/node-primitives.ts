// Measurement tooling only. Node KeyObjects are exportable software keys, not
// an OS-protected key service. Nothing in this directory is a production export.
import { Buffer } from "node:buffer"
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey,
  createPublicKey, diffieHellman, generateKeyPairSync, KeyObject,
} from "node:crypto"

export const nodeSuites = [
  { name: "Noise_IK_25519_ChaChaPoly_SHA256", curve: "x25519", aes: false, publicLength: 32 },
  { name: "Noise_IK_25519_AESGCM_SHA256", curve: "x25519", aes: true, publicLength: 32 },
  { name: "Noise_IK_P256_AESGCM_SHA256", curve: "prime256v1", aes: true, publicLength: 65 },
] as const
export type NodeSuite = typeof nodeSuites[number]

export function reject(): never { throw new Error("Relay channel rejected") }

export function nodeSuite(name: string): NodeSuite {
  return nodeSuites.find((suite) => suite.name === name) ?? reject()
}

export function bound(bytes: Uint8Array, min: number, max: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) reject()
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts)
}

export function sha256(bytes: Uint8Array): Uint8Array { return createHash("sha256").update(bytes).digest() }
export function hmac(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  return createHmac("sha256", key).update(bytes).digest()
}

export function generatePrivateKey(suite: NodeSuite): KeyObject {
  return suite.curve === "x25519" ? generateKeyPairSync("x25519").privateKey
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
}

function validatePrivate(suite: NodeSuite, key: KeyObject): KeyObject {
  if (key.type !== "private") reject()
  if (suite.curve === "x25519") {
    if (key.asymmetricKeyType !== "x25519") reject()
  } else if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") reject()
  return key
}

export function privateKey(suite: NodeSuite, input: Uint8Array | KeyObject): KeyObject {
  if (input instanceof KeyObject) return validatePrivate(suite, input)
  bound(input, 32, 32)
  const x25519 = suite.curve === "x25519"
  // Public fixture scalars only. Live benchmark keys use generateKeyPairSync
  // and stay in KeyObjects. PKCS8 for X25519; SEC1 with curve OID for P-256.
  const der = Buffer.concat(x25519 ? [Buffer.from("302e020100300506032b656e04220420", "hex"), input]
    : [Buffer.from("30310201010420", "hex"), input, Buffer.from("a00a06082a8648ce3d030107", "hex")])
  try {
    return validatePrivate(suite, createPrivateKey({ key: der, format: "der", type: x25519 ? "pkcs8" : "sec1" }))
  } finally { der.fill(0) }
}

export function publicBytes(suite: NodeSuite, key: KeyObject): Uint8Array {
  validatePrivate(suite, key)
  const der = createPublicKey(key).export({ format: "der", type: "spki" })
  return new Uint8Array(der.subarray(-suite.publicLength))
}

export function peerKey(suite: NodeSuite, bytes: Uint8Array): KeyObject {
  bound(bytes, suite.publicLength, suite.publicLength)
  if (suite.curve === "prime256v1" && bytes[0] !== 4) reject()
  const prefix = suite.curve === "x25519" ? "302a300506032b656e032100"
    : "3059301306072a8648ce3d020106082a8648ce3d030107034200"
  // OpenSSL validates the P-256 point on import. Compressed points and points
  // at infinity are outside the measured Snow uncompressed-wire profile.
  return createPublicKey({ key: Buffer.concat([Buffer.from(prefix, "hex"), bytes]), format: "der", type: "spki" })
}

export function dh(suite: NodeSuite, own: KeyObject | undefined, peer: Uint8Array): Uint8Array {
  if (!own) reject()
  const result = diffieHellman({ privateKey: own, publicKey: peerKey(suite, peer) })
  if (result.length !== 32 || result.every((byte) => byte === 0)) reject()
  return result
}

export class NodeCipherState {
  nonce = 0n
  constructor(readonly suite: NodeSuite, readonly key: Uint8Array) {}

  crypt(input: Uint8Array, ad: Uint8Array, decrypt: boolean): Uint8Array {
    if (this.nonce < 0n || this.nonce >= 0xffffffffffffffffn) reject()
    const nonce = Buffer.alloc(12)
    if (this.suite.aes) nonce.writeBigUInt64BE(this.nonce, 4)
    else nonce.writeBigUInt64LE(this.nonce, 4)
    let result: Uint8Array
    if (decrypt) {
      bound(input, 16, 65535)
      const cipher = this.suite.aes ? createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: 16 })
        : createDecipheriv("chacha20-poly1305", this.key, nonce, { authTagLength: 16 })
      cipher.setAAD(ad)
      cipher.setAuthTag(input.subarray(-16))
      const plaintext = cipher.update(input.subarray(0, -16))
      try { result = concat(plaintext, cipher.final()) } finally { plaintext.fill(0) }
    } else {
      const cipher = this.suite.aes ? createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: 16 })
        : createCipheriv("chacha20-poly1305", this.key, nonce, { authTagLength: 16 })
      cipher.setAAD(ad)
      result = concat(cipher.update(input), cipher.final(), cipher.getAuthTag())
    }
    this.nonce += 1n
    return result
  }
}
