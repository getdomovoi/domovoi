import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { describe, expect, it, vi } from "vitest"

import { adoptRelayRecovery } from "../relay-admission/pin-recovery.js"
import { relayPublicKeyFromPrivateKey } from "../relay-admission/channel.js"
import { relaySuccessorSigningBytes } from "../relay-admission/identity.js"
import { deviceClaimResultSchema, devicePairResultSchema } from "./devices.js"
import { protocolVersion } from "./protocol-version.js"
import { relayRecoveryParamsSchema, relayRecoveryResultSchema, maximumRelayRecoveryBytes } from "./relay-recovery.js"
import { rpcMethods, isMutatingRpcMethod } from "./rpc.js"
import type { RelayClientPin } from "./relay-pin-recovery.js"
import type { RelayIdentityPin, RelaySuccessorStatement } from "./relay-identity.js"

function fixture() {
  const signer = generateKeyPairSync("ed25519")
  const channel = () => {
    const key = randomBytes(32)
    try { return { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(key) } }
    finally { key.fill(0) }
  }
  const identity: RelayIdentityPin = { version: 1, machineId: "machine-" + "a".repeat(32),
    identityPublicKey: signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"), generation: 1, channel: channel() }
  const next = { ...identity, generation: 2, channel: channel() }
  const statement = { ...next, previousChannelPublicKey: identity.channel.responderPublicKey }
  const successor = { statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") }
  let saved: RelayClientPin = { version: 1, state: "recovery-required", identity }
  const store = { read: async () => structuredClone(saved), compareAndSwap: vi.fn(async (expected: RelayClientPin, replacement: RelayClientPin) => {
    if (!isDeepStrictEqual(saved, expected)) return false
    saved = structuredClone(replacement)
    return true
  }) }
  const signed = (statement: RelaySuccessorStatement) => ({ statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") })
  return { identity, next, successor, store, signed, result: { identity: next, successor } }
}

describe("public successor delivery schemas", () => {
  it("scopes the pre-admission query by machine and accepts no bearer", () => {
    const { identity } = fixture()
    const params = { machineId: identity.machineId }
    expect(relayRecoveryParamsSchema.parse(params)).toEqual(params)
    for (const extra of [{ authToken: "x".repeat(43) }, { token: "x".repeat(43) }, { privateKey: "secret" }, { identityPublicKey: identity.identityPublicKey }]) {
      expect(relayRecoveryParamsSchema.safeParse({ ...params, ...extra }).success).toBe(false)
    }
    expect(relayRecoveryParamsSchema.safeParse({ machineId: "foreign" }).success).toBe(false)
    expect(rpcMethods["relay.recovery"].params).toBe(relayRecoveryParamsSchema)
    expect(rpcMethods["relay.recovery"].result).toBe(relayRecoveryResultSchema)
    expect(isMutatingRpcMethod("relay.recovery")).toBe(false)
  })

  it("requires the current pin and latest envelope to describe the same successor", () => {
    const f = fixture()
    expect(relayRecoveryResultSchema.parse({ identity: f.identity })).toEqual({ identity: f.identity })
    expect(relayRecoveryResultSchema.parse(f.result)).toEqual(f.result)
    for (const result of [
      { identity: f.next }, { identity: f.identity, successor: f.successor },
      { ...f.result, identity: { ...f.next, channel: f.identity.channel } },
      { ...f.result, identity: { ...f.next, machineId: "machine-" + "b".repeat(32) } },
      { ...f.result, identity: { ...f.next, identityPublicKey: f.identity.channel.responderPublicKey } },
      { ...f.result, successor: { ...f.successor, signature: f.successor.signature + "A" } },
      { ...f.result, custody: { kind: "file", path: "/secret" } },
      { ...f.result, identity: { ...f.next, privateKey: "secret" } },
    ]) expect(relayRecoveryResultSchema.safeParse(result).success).toBe(false)
  })

  it("bounds the entire response even at the largest accepted generation", () => {
    const f = fixture()
    const result = { identity: { ...f.next, generation: Number.MAX_SAFE_INTEGER },
      successor: { ...f.successor, statement: { ...f.successor.statement, generation: Number.MAX_SAFE_INTEGER } } }
    expect(relayRecoveryResultSchema.safeParse(result).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maximumRelayRecoveryBytes)
    expect(maximumRelayRecoveryBytes).toBeLessThanOrEqual(2_048)
  })

  it("co-publishes the identity and channel pins only for opt-in pairing", () => {
    const { identity } = fixture()
    const paired = { device: { id: "device-" + "b".repeat(32), label: "phone", pairedAt: "2026-09-13T00:00:00Z", binding: { kind: "client", client: "phone" } }, token: "x".repeat(43) }
    expect(devicePairResultSchema.parse(paired)).toEqual(paired)
    const result = { ...paired, relay: identity.channel, relayIdentity: identity }
    expect(devicePairResultSchema.parse(result)).toEqual(result)
    for (const patch of [{ relayIdentity: undefined }, { relay: undefined }, { relay: { ...identity.channel, responderPublicKey: fixture().identity.channel.responderPublicKey } }]) {
      expect(devicePairResultSchema.safeParse({ ...result, ...patch }).success).toBe(false)
    }
  })

  it("binds the claim identity to the daemon descriptor, not the claiming machine", () => {
    const { identity } = fixture()
    const result = { claim: { state: "pending", deviceId: "device-" + "b".repeat(32), machineId: "machine-" + "c".repeat(32), expiresAt: "2026-09-13T00:00:00Z" },
      token: "x".repeat(43), machine: { id: identity.machineId, label: "target", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion, capabilities: [], transports: [] },
      relay: identity.channel, relayIdentity: identity }
    expect(deviceClaimResultSchema.parse(result)).toEqual(result)
    expect(deviceClaimResultSchema.safeParse({ ...result, relayIdentity: { ...identity, machineId: result.claim.machineId } }).success).toBe(false)
    expect(deviceClaimResultSchema.safeParse({ ...result, relayIdentity: undefined }).success).toBe(false)
  })
})

describe("adopting publicly delivered successors", () => {
  it("verifies against saved identity and persists the complete replacement", async () => {
    const f = fixture()
    await expect(adoptRelayRecovery(f.store, f.result)).resolves.toEqual({ version: 1, state: "trusted", identity: f.next })
    expect(f.store.compareAndSwap).toHaveBeenCalledWith({ version: 1, state: "recovery-required", identity: f.identity }, { version: 1, state: "trusted", identity: f.next })
    await expect(adoptRelayRecovery(f.store, f.result)).rejects.toThrow("successor rejected")
  })

  it("never treats the fetched public pin as a replacement trust anchor", async () => {
    const f = fixture(), attacker = fixture()
    await expect(adoptRelayRecovery(f.store, attacker.result)).rejects.toThrow("successor rejected")
    const tampered = { ...f.result, successor: { ...f.successor, signature: Buffer.alloc(64).toString("base64url") } }
    await expect(adoptRelayRecovery(f.store, tampered)).rejects.toThrow("successor rejected")
    await expect(adoptRelayRecovery(f.store, { identity: f.identity })).rejects.toThrow("successor")
    expect(f.store.compareAndSwap).not.toHaveBeenCalled()
    expect((await f.store.read()).state).toBe("recovery-required")
  })

  it("refuses a missing generation instead of skipping the predecessor check", async () => {
    const f = fixture()
    const result = { identity: { ...f.next, generation: 3 }, successor: f.signed({ ...f.successor.statement, generation: 3 }) }
    await expect(adoptRelayRecovery(f.store, result)).rejects.toThrow("successor rejected")
    expect(f.store.compareAndSwap).not.toHaveBeenCalled()
  })

  it("does not clear distrust on conflicting or failed durable replacement", async () => {
    const f = fixture()
    f.store.compareAndSwap.mockResolvedValueOnce(false)
    await expect(adoptRelayRecovery(f.store, f.result)).rejects.toThrow("changed during recovery")
    f.store.compareAndSwap.mockRejectedValueOnce(new Error("disk failure"))
    await expect(adoptRelayRecovery(f.store, f.result)).rejects.toThrow("disk failure")
    expect((await f.store.read()).state).toBe("recovery-required")
  })
})
