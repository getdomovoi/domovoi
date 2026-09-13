import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPrivateKey, createPublicKey, sign } from "node:crypto"

import type { RelayClientPin, RelaySignedSuccessor } from "@getdomovoi/protocol"
import { adoptRelayPinSuccessor, createPinnedRelayClient, relaySuccessorSigningBytes, requireRelayPinRecovery } from "@getdomovoi/protocol/relay-admission"
import { afterEach, describe, expect, it } from "vitest"

import { openCredentialStore, type Keyring, type PairedDaemon } from "./credentials.js"
import { relayPinStore } from "./relay-pin.js"

const memoryKeyring = (): Keyring => {
  const entries = new Map<string, string>()
  return {
    available: async () => true,
    get: async (account) => entries.get(account),
    set: async (account, secret) => { entries.set(account, secret) },
    delete: async (account) => { entries.delete(account) },
  }
}

const absentKeyring: Keyring = {
  available: async () => false,
  get: async () => { throw new Error("no keyring") },
  set: async () => { throw new Error("no keyring") },
  delete: async () => { throw new Error("no keyring") },
}

const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "domovoi-cli-relay-pin-"))
  scratch.push(path)
  return path
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

// Raw 32-byte seeds wrapped as PKCS#8 so node:crypto can use them. The test
// signs with Node so the CLI package needs no curve dependency of its own.
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

const paired: PairedDaemon = {
  endpoint: "ws://127.0.0.1:47831/rpc",
  machineId,
  deviceId: `device-${"b".repeat(32)}`,
  token: "t".repeat(43),
}

const trusted: RelayClientPin = {
  version: 1,
  state: "trusted",
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

describe("relay pin store", () => {
  it("reads nothing until a pin is saved with the paired record, then reads it back", async () => {
    const store = await openCredentialStore({ keyring: memoryKeyring(), home: await directory(), warn: () => {} })
    await store.save(paired)
    const pins = relayPinStore(store, paired.endpoint)
    expect(await pins.read()).toBeUndefined()
    expect(await pins.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await pins.read()).toEqual(trusted)
    expect(await store.load(paired.endpoint)).toMatchObject({ token: paired.token, relayPin: trusted })
  })

  it("refuses to swap when the saved pin is not the expected one", async () => {
    const store = await openCredentialStore({ keyring: memoryKeyring(), home: await directory(), warn: () => {} })
    await store.save(paired)
    const pins = relayPinStore(store, paired.endpoint)
    await pins.compareAndSwap(undefined, trusted)
    const stale = { ...trusted, identity: { ...trusted.identity, generation: 5 } }
    expect(await pins.compareAndSwap(stale, { ...trusted, state: "recovery-required" })).toBe(false)
    expect(await pins.read()).toEqual(trusted)
    expect(await pins.compareAndSwap(undefined, trusted)).toBe(false)
  })

  it("refuses when there is no pairing to attach the pin to", async () => {
    const store = await openCredentialStore({ keyring: memoryKeyring(), home: await directory(), warn: () => {} })
    const pins = relayPinStore(store, paired.endpoint)
    await expect(pins.compareAndSwap(undefined, trusted)).rejects.toThrow(/not paired/)
  })

  it("serialises two writers on one credential file so exactly one swap wins", async () => {
    const home = await directory()
    const file = join(home, "cli-credentials.json")
    const first = await openCredentialStore({ keyring: absentKeyring, home, credentialFile: file, warn: () => {} })
    await first.save(paired)
    const second = await openCredentialStore({ keyring: absentKeyring, home, credentialFile: file, warn: () => {} })
    const a = relayPinStore(first, paired.endpoint)
    const b = relayPinStore(second, paired.endpoint)
    const [wonA, wonB] = await Promise.all([
      a.compareAndSwap(undefined, trusted),
      b.compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1)
    const saved = await a.read()
    expect(saved).toEqual(wonA ? trusted : { ...trusted, state: "recovery-required" })
  })

  it("runs the protocol's recovery and adoption against the CLI store", async () => {
    const store = await openCredentialStore({ keyring: memoryKeyring(), home: await directory(), warn: () => {} })
    await store.save(paired)
    const pins = relayPinStore(store, paired.endpoint)
    await pins.compareAndSwap(undefined, trusted)

    const required = await requireRelayPinRecovery(pins)
    expect(required.state).toBe("recovery-required")
    const carrier = { bufferedAmount: 0, send: () => {}, close: () => {} }
    await expect(createPinnedRelayClient(pins, { machineId, routeId: "A".repeat(42) + "A", staticPrivateKey: new Uint8Array(32).fill(9), carrier, onMessage: () => {}, token: "t".repeat(43) }))
      .rejects.toThrow(/recovery is required/)

    const adopted = await adoptRelayPinSuccessor(pins, signedSuccessor(trusted, 11))
    expect(adopted.state).toBe("trusted")
    expect(adopted.identity.generation).toBe(2)
    expect(adopted.identity.channel.responderPublicKey).toBe(channelKey(11))
    expect(await pins.read()).toEqual(adopted)

    // A replayed successor for the old generation cannot move the pin back.
    await expect(adoptRelayPinSuccessor(pins, signedSuccessor(trusted, 12))).rejects.toThrow(/successor rejected/)
    expect(await pins.read()).toEqual(adopted)
  })
})
