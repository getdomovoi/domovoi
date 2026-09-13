import { createPrivateKey, createPublicKey, sign } from "node:crypto"

import type { RelayClientPin, RelaySignedSuccessor } from "@getdomovoi/protocol"
import { adoptRelayPinSuccessor, relaySuccessorSigningBytes, requireRelayPinRecovery } from "@getdomovoi/protocol/relay-admission"
import { describe, expect, it } from "vitest"

import { createRelayPinStore, readRelayPin, relayPinKey, type SecretItems } from "./relay-pin"

function memorySecrets(options: { corruptWrites?: boolean } = {}): SecretItems & { writes: number } {
  const items = new Map<string, string>()
  return {
    writes: 0,
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value) => { items.set(key, options.corruptWrites ? `${value} ` : value) },
    deleteItemAsync: async (key) => { items.delete(key) },
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) { bits -= 6; result += alphabet[(value >>> bits) & 63] }
  }
  if (bits > 0) result += alphabet[(value << (6 - bits)) & 63]
  return result
}
function privateKey(algorithm: "ed25519" | "x25519", seed: Uint8Array) {
  const oid = algorithm === "ed25519" ? "06032b6570" : "06032b656e"
  return createPrivateKey({ key: Buffer.concat([Buffer.from(`302e0201003005${oid}04220420`, "hex"), seed]), format: "der", type: "pkcs8" })
}
function publicKey(algorithm: "ed25519" | "x25519", seed: Uint8Array): string {
  const der = createPublicKey(privateKey(algorithm, seed)).export({ format: "der", type: "spki" })
  return encode(new Uint8Array(der.subarray(der.length - 32)))
}

const machineId = `machine-${"a".repeat(32)}`
const identityPrivate = new Uint8Array(32).fill(3)
const identityPublicKey = publicKey("ed25519", identityPrivate)
const channelKey = (fill: number) => publicKey("x25519", new Uint8Array(32).fill(fill))
const trusted: RelayClientPin = {
  version: 1, state: "trusted",
  identity: { version: 1, machineId, identityPublicKey, generation: 1, channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: channelKey(7) } },
}
function signedSuccessor(from: RelayClientPin, nextFill: number): RelaySignedSuccessor {
  const statement = {
    version: 1 as const, machineId, identityPublicKey, generation: from.identity.generation + 1,
    previousChannelPublicKey: from.identity.channel.responderPublicKey,
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: channelKey(nextFill) },
  }
  return { statement, signature: encode(new Uint8Array(sign(null, relaySuccessorSigningBytes(statement), privateKey("ed25519", identityPrivate)))) }
}

describe("phone relay pin store", () => {
  it("enrols a pin, reads it back, and refuses a swap against a pin that is not saved", async () => {
    const secrets = memorySecrets()
    const store = createRelayPinStore(secrets)
    expect(await store.read()).toBeUndefined()
    expect(await store.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await store.read()).toEqual(trusted)
    expect(await readRelayPin(secrets)).toEqual(trusted)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(false)
    const stale = { ...trusted, identity: { ...trusted.identity, generation: 4 } }
    expect(await store.compareAndSwap(stale, { ...trusted, state: "recovery-required" })).toBe(false)
    expect(await store.read()).toEqual(trusted)
  })

  it("serialises concurrent swaps in this process so exactly one wins", async () => {
    const store = createRelayPinStore(memorySecrets())
    const [a, b] = await Promise.all([
      store.compareAndSwap(undefined, trusted),
      store.compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("treats a stored value that does not parse as absent for reads and refuses to swap over it", async () => {
    const secrets = memorySecrets()
    await secrets.setItemAsync(relayPinKey, "{not json")
    const store = createRelayPinStore(secrets)
    await expect(store.read()).rejects.toThrow(/relay pin/)
    await expect(store.compareAndSwap(undefined, trusted)).rejects.toThrow(/relay pin/)
  })

  it("refuses a write whose read-back does not match", async () => {
    const store = createRelayPinStore(memorySecrets({ corruptWrites: true }))
    await expect(store.compareAndSwap(undefined, trusted)).rejects.toThrow(/read-back/)
  })

  it("runs the protocol's recovery and adoption against SecureStore-shaped storage", async () => {
    const store = createRelayPinStore(memorySecrets())
    await store.compareAndSwap(undefined, trusted)
    expect((await requireRelayPinRecovery(store)).state).toBe("recovery-required")
    const adopted = await adoptRelayPinSuccessor(store, signedSuccessor(trusted, 11))
    expect(adopted.identity.generation).toBe(2)
    expect(await store.read()).toEqual(adopted)
    await expect(adoptRelayPinSuccessor(store, signedSuccessor(trusted, 12))).rejects.toThrow(/successor rejected/)
  })
})
