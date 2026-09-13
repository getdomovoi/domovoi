import { ed25519, x25519 } from "@noble/curves/ed25519.js"

import { relayPublicKeySchema } from "../src/relay-admission.js"
import { relayIdentityPinSchema, relaySignedSuccessorSchema, relaySuccessorStatementSchema, type RelayIdentityPin } from "../src/relay-identity.js"

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function decode(text: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(text.length * 6 / 8))
  let bits = 0, value = 0, offset = 0
  for (const character of text) {
    value = (value << 6) | alphabet.indexOf(character)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes[offset++] = (value >>> bits) & 255 }
  }
  return bytes
}

export function relayIdentityPublicKeyIsValid(value: unknown): value is string {
  const parsed = relayPublicKeySchema.safeParse(value)
  if (!parsed.success) return false
  try {
    const point = ed25519.Point.fromBytes(decode(parsed.data), false)
    return !point.isSmallOrder() && point.isTorsionFree()
  } catch { return false }
}

// Public signing input for an external signer. No identity private-key API is
// exposed here. Fixed field order and a domain prefix are part of version 1.
export function relaySuccessorSigningBytes(value: unknown): Uint8Array {
  const statement = relaySuccessorStatementSchema.parse(value)
  return new TextEncoder().encode("domovoi.relay-channel-successor.v1\0" + JSON.stringify([
    statement.version, statement.machineId, statement.identityPublicKey, statement.generation,
    statement.previousChannelPublicKey, statement.channel.suite, statement.channel.responderPublicKey,
  ]))
}

export function verifyRelayChannelSuccessor(pinned: unknown, envelope: unknown): RelayIdentityPin {
  try {
    const current = relayIdentityPinSchema.parse(pinned)
    const { statement, signature } = relaySignedSuccessorSchema.parse(envelope)
    if (!relayIdentityPublicKeyIsValid(current.identityPublicKey)
      || statement.identityPublicKey !== current.identityPublicKey
      || statement.machineId !== current.machineId
      || current.generation === Number.MAX_SAFE_INTEGER
      || statement.generation !== current.generation + 1
      || statement.previousChannelPublicKey !== current.channel.responderPublicKey
      || statement.channel.responderPublicKey === current.channel.responderPublicKey
      || !ed25519.verify(decode(signature), relaySuccessorSigningBytes(statement), decode(current.identityPublicKey), { zip215: false })) {
      throw new Error("invalid")
    }
    // X25519 rejects low-order points with a zero shared secret. This fixed
    // public probe is validation, not a channel secret or part of the codec.
    const channelKey = decode(statement.channel.responderPublicKey)
    let coordinate = 0n
    for (let index = channelKey.length - 1; index >= 0; index -= 1) coordinate = (coordinate << 8n) | BigInt(channelKey[index]!)
    // X25519 masks bit 255 and accepts coordinates reduced modulo p. A textual
    // alias of the old key must not count as replacing a stolen private key.
    if (coordinate >= (1n << 255n) - 19n) throw new Error("noncanonical")
    x25519.getSharedSecret(new Uint8Array(32).fill(1), channelKey).fill(0)
    return { ...current, generation: statement.generation, channel: statement.channel }
  } catch { throw new Error("Relay identity successor rejected") }
}
