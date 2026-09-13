import { createPrivateKey, createPublicKey, sign } from "node:crypto"

import type { RelayClientPin, RelaySignedSuccessor } from "@getdomovoi/protocol"
import { adoptRelayPinSuccessor, relaySuccessorSigningBytes, requireRelayPinRecovery } from "@getdomovoi/protocol/relay-admission"
import { describe, expect, it } from "vitest"

import { createRelayPinStore, readRelayPin, reconcileRelayPin, relayPinKey, type SecretItems } from "./relay-pin"

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
    const store = createRelayPinStore(secrets, machineId)
    expect(await store.read()).toBeUndefined()
    expect(await store.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await store.read()).toEqual(trusted)
    expect(await readRelayPin(secrets, machineId)).toEqual(trusted)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(false)
    const stale = { ...trusted, identity: { ...trusted.identity, generation: 4 } }
    expect(await store.compareAndSwap(stale, { ...trusted, state: "recovery-required" })).toBe(false)
    expect(await store.read()).toEqual(trusted)
  })

  it("serialises concurrent swaps in this process so exactly one wins", async () => {
    const store = createRelayPinStore(memorySecrets(), machineId)
    const [a, b] = await Promise.all([
      store.compareAndSwap(undefined, trusted),
      store.compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("serialises two store handles over one secret store so exactly one swap wins", async () => {
    const secrets = memorySecrets()
    const [a, b] = await Promise.all([
      createRelayPinStore(secrets, machineId).compareAndSwap(undefined, trusted),
      createRelayPinStore(secrets, machineId).compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("treats a stored value that does not parse as absent for reads and refuses to swap over it", async () => {
    const secrets = memorySecrets()
    await secrets.setItemAsync(relayPinKey(machineId), "{not json")
    const store = createRelayPinStore(secrets, machineId)
    await expect(store.read()).rejects.toThrow(/relay pin/)
    await expect(store.compareAndSwap(undefined, trusted)).rejects.toThrow(/relay pin/)
  })

  it("reports an unconfirmed write when the read-back does not match, and says to read again", async () => {
    const store = createRelayPinStore(memorySecrets({ corruptWrites: true }), machineId)
    await expect(store.compareAndSwap(undefined, trusted)).rejects.toThrow(/could not be confirmed.*read the saved pin again/)
    // The write did land; a later read must say so rather than the error claiming absence.
    expect(await store.read()).toEqual(trusted)
  })

  it("runs the protocol's recovery and adoption against SecureStore-shaped storage", async () => {
    const store = createRelayPinStore(memorySecrets(), machineId)
    await store.compareAndSwap(undefined, trusted)
    expect((await requireRelayPinRecovery(store)).state).toBe("recovery-required")
    const adopted = await adoptRelayPinSuccessor(store, signedSuccessor(trusted, 11))
    expect(adopted.identity.generation).toBe(2)
    expect(await store.read()).toEqual(adopted)
    await expect(adoptRelayPinSuccessor(store, signedSuccessor(trusted, 12))).rejects.toThrow(/successor rejected/)
  })

  describe("reconcile against a daemon", () => {
    const publication = (pin: RelayClientPin, successor?: RelaySignedSuccessor) => ({
      identity: successor ? { ...pin.identity, generation: successor.statement.generation, channel: successor.statement.channel } : pin.identity,
      ...(successor ? { successor } : {}),
    })

    it("enrols the published identity when nothing is saved, then leaves a trusted pin alone", async () => {
      const store = createRelayPinStore(memorySecrets(), machineId)
      const calls: string[] = []
      const call = async (method: string) => { calls.push(method); return publication(trusted) }
      expect(await reconcileRelayPin({ store, machineId, call })).toBe("enrolled")
      expect(await store.read()).toEqual(trusted)
      expect(await reconcileRelayPin({ store, machineId, call })).toBe("trusted")
      expect(calls).toEqual(["relay.recovery"])
    })

    it("leaves the phone without a pin when the daemon publishes none", async () => {
      const store = createRelayPinStore(memorySecrets(), machineId)
      expect(await reconcileRelayPin({ store, machineId, call: async () => { throw new Error("Relay recovery is unavailable") } })).toBe("unavailable")
      expect(await store.read()).toBeUndefined()
    })

    it("recovers a distrusted pin from the fetched successor and refuses a fetch without one", async () => {
      const store = createRelayPinStore(memorySecrets(), machineId)
      await store.compareAndSwap(undefined, trusted)
      await requireRelayPinRecovery(store)
      const foreign = { ...trusted, identity: { ...trusted.identity, channel: { ...trusted.identity.channel, responderPublicKey: channelKey(30) } } }
      await expect(reconcileRelayPin({ store, machineId, call: async () => publication(foreign) })).rejects.toThrow(/No relay successor/)
      expect((await store.read())?.state).toBe("recovery-required")
      expect(await reconcileRelayPin({ store, machineId, call: async () => publication(trusted, signedSuccessor(trusted, 21)) })).toBe("recovered")
      const saved = await store.read()
      expect(saved?.state).toBe("trusted")
      expect(saved?.identity.channel.responderPublicKey).toBe(channelKey(21))
    })
  })

  it("keeps one pin per machine, so pairing with another daemon starts with no pin", async () => {
    const secrets = memorySecrets()
    await createRelayPinStore(secrets, machineId).compareAndSwap(undefined, trusted)
    const otherMachine = `machine-${"b".repeat(32)}`
    const other = createRelayPinStore(secrets, otherMachine)
    expect(await other.read()).toBeUndefined()
    const calls: string[] = []
    const call = async (method: string) => { calls.push(method); throw new Error("Relay recovery is unavailable") }
    expect(await reconcileRelayPin({ store: other, machineId: otherMachine, call })).toBe("unavailable")
    expect(calls).toEqual(["relay.recovery"])
    // The first machine's pin is untouched, and a pin for another machine cannot be written under this key.
    expect(await createRelayPinStore(secrets, machineId).read()).toEqual(trusted)
    await expect(other.compareAndSwap(undefined, trusted)).rejects.toThrow(/another machine/)
  })
})
