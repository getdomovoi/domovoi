import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { describe, expect, it, vi } from "vitest"

import { relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes } from "../relay-admission/index.js"
import { adoptRelayPinSuccessor, createPinnedRelayClient, requireRelayPinRecovery, type RelayPinStore } from "../relay-admission/pin-recovery.js"
import { relayClientPinSchema, type RelayClientPin } from "./relay-pin-recovery.js"

function fixture() {
  const signer = generateKeyPairSync("ed25519")
  const identity = {
    version: 1 as const, machineId: "machine-" + "a".repeat(32), generation: 1,
    identityPublicKey: signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(randomBytes(32)) },
  }
  let saved: RelayClientPin = { version: 1, identity, state: "trusted" }
  const store: RelayPinStore = {
    read: async () => structuredClone(saved),
    compareAndSwap: vi.fn(async (expected, next) => {
      if (!isDeepStrictEqual(saved, expected)) return false
      saved = structuredClone(next)
      return true
    }),
  }
  const statement = {
    version: 1 as const, machineId: identity.machineId, identityPublicKey: identity.identityPublicKey, generation: 2,
    previousChannelPublicKey: identity.channel.responderPublicKey,
    channel: { ...identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(randomBytes(32)) },
  }
  const successor = { statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") }
  const send = vi.fn(), close = vi.fn()
  const options = { machineId: identity.machineId, routeId: Buffer.alloc(32, 9).toString("base64url"), token: randomBytes(32).toString("base64url"), staticPrivateKey: randomBytes(32), carrier: { bufferedAmount: 0, send, close }, onMessage: vi.fn() }
  return { identity, store, successor, options, send, saved: () => saved }
}

describe("relay client pin recovery", () => {
  it("persists distrust, refuses the old pin, and starts channels only after signed adoption is stored", async () => {
    const { store, successor, options, send, saved } = fixture()
    await requireRelayPinRecovery(store)
    const signature = Buffer.from(successor.signature, "base64url")
    signature[0] = signature[0]! ^ 1
    await expect(adoptRelayPinSuccessor(store, { ...successor, signature: signature.toString("base64url") })).rejects.toThrow("Relay identity successor rejected")
    expect(saved().state).toBe("recovery-required")
    await expect(createPinnedRelayClient(store, options)).rejects.toThrow("Relay pin recovery is required")
    expect(send).not.toHaveBeenCalled()
    await expect(adoptRelayPinSuccessor(store, successor)).resolves.toMatchObject({ state: "trusted", identity: { generation: 2, channel: successor.statement.channel } })
    expect(saved().identity.channel).toEqual(successor.statement.channel)
    const client = await createPinnedRelayClient(store, options)
    try { client.start(); expect(send).toHaveBeenCalledOnce() } finally { client.close() }
    await expect(adoptRelayPinSuccessor(store, successor)).rejects.toThrow("Relay identity successor rejected")
  })

  it("leaves distrust intact on signature failure, persistence failure, or a concurrent pin change", async () => {
    const { store, successor, saved } = fixture()
    await requireRelayPinRecovery(store)
    await expect(adoptRelayPinSuccessor(store, { ...successor, statement: { ...successor.statement, machineId: "machine-" + "b".repeat(32) } })).rejects.toThrow("Relay identity successor rejected")
    vi.mocked(store.compareAndSwap).mockRejectedValueOnce(new Error("disk full"))
    await expect(adoptRelayPinSuccessor(store, successor)).rejects.toThrow("disk full")
    vi.mocked(store.compareAndSwap).mockResolvedValueOnce(false)
    await expect(adoptRelayPinSuccessor(store, successor)).rejects.toThrow("Relay pin changed during recovery")
    expect(saved().state).toBe("recovery-required")
    expect(saved().identity.generation).toBe(1)
  })

  it("refuses missing, malformed, foreign and non-public saved pins before creating a channel", async () => {
    const { store, options, send, saved } = fixture()
    expect(relayClientPinSchema.safeParse({ ...saved(), privateKey: "secret" }).success).toBe(false)
    expect(relayClientPinSchema.safeParse({ ...saved(), state: "unknown" }).success).toBe(false)
    await expect(createPinnedRelayClient({ ...store, read: async () => undefined }, options)).rejects.toThrow("Saved relay pin rejected")
    await expect(createPinnedRelayClient({ ...store, read: async () => ({ ...saved(), identity: { ...saved().identity, identityPublicKey: Buffer.alloc(32).toString("base64url") } }) }, options)).rejects.toThrow("Saved relay pin rejected")
    await expect(createPinnedRelayClient(store, { ...options, machineId: "machine-" + "b".repeat(32) })).rejects.toThrow("Relay pin belongs to another machine")
    expect(send).not.toHaveBeenCalled()
  })

  it("does not clear distrust while durable adoption is still pending", async () => {
    const { store, options, successor, saved } = fixture()
    await requireRelayPinRecovery(store)
    const commit = store.compareAndSwap
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    store.compareAndSwap = async (expected, next) => { await waiting; return commit(expected, next) }
    const adopting = adoptRelayPinSuccessor(store, successor)
    await expect(createPinnedRelayClient(store, options)).rejects.toThrow("Relay pin recovery is required")
    expect(saved().identity.generation).toBe(1)
    release()
    await adopting
    expect(saved().identity.generation).toBe(2)
  })

  it("can adopt directly from a trusted pin and marking recovery twice does not write again", async () => {
    const { store, successor } = fixture()
    await adoptRelayPinSuccessor(store, successor)
    await requireRelayPinRecovery(store)
    vi.mocked(store.compareAndSwap).mockClear()
    await requireRelayPinRecovery(store)
    expect(store.compareAndSwap).not.toHaveBeenCalled()
  })
})
