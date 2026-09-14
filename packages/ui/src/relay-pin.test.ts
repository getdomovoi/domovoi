import { createPrivateKey, createPublicKey, sign } from "node:crypto"

import type { RelayClientPin, RelaySignedSuccessor } from "@getdomovoi/protocol"
import { adoptRelayPinSuccessor, relaySuccessorSigningBytes, requireRelayPinRecovery } from "@getdomovoi/protocol/relay-admission"
import { describe, expect, it } from "vitest"

import { DaemonRpcError, DomovoiRpcTimeoutError } from "./client"
import {
  bridgeRelayPinStorage,
  createRelayPinStore,
  localStorageRelayPinStorage,
  readRelayPin,
  reconcileRelayPin,
  relayPinKey,
  type RelayPinStorage,
} from "./relay-pin"

function memoryStorage(): RelayPinStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    async read(key) { return items.get(key) },
    async compareAndSwap(key, expected, replacement) {
      if (items.get(key) !== expected) return false
      items.set(key, replacement)
      return true
    },
  }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function encode(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) {
    out += byte.toString(2).padStart(8, "0")
  }
  let result = ""
  for (let index = 0; index < out.length; index += 6) {
    const chunk = out.slice(index, index + 6).padEnd(6, "0")
    result += alphabet[Number.parseInt(chunk, 2)]
  }
  return result
}
function privateKey(algorithm: "ed25519" | "x25519", seed: Uint8Array) {
  const oid = algorithm === "ed25519" ? "06032b6570" : "06032b656e"
  return createPrivateKey({ key: Buffer.from(`302e0201003005${oid}04220420${Buffer.from(seed).toString("hex")}`, "hex"), format: "der", type: "pkcs8" })
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

describe("browser and desktop relay pin store", () => {
  it("enrols a pin, reads it back, and refuses a swap against a pin that is not saved", async () => {
    const storage = memoryStorage()
    const store = createRelayPinStore(storage, machineId)
    expect(await store.read()).toBeUndefined()
    expect(await store.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await store.read()).toEqual(trusted)
    expect(await readRelayPin(storage, machineId)).toEqual(trusted)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(false)
    const stale = { ...trusted, identity: { ...trusted.identity, generation: 4 } }
    expect(await store.compareAndSwap(stale, { ...trusted, state: "recovery-required" })).toBe(false)
    expect(await store.read()).toEqual(trusted)
  })

  it("serialises concurrent swaps in this process so exactly one wins", async () => {
    const store = createRelayPinStore(memoryStorage(), machineId)
    const [a, b] = await Promise.all([
      store.compareAndSwap(undefined, trusted),
      store.compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("serialises two store handles over one storage so exactly one swap wins", async () => {
    const storage = memoryStorage()
    const [a, b] = await Promise.all([
      createRelayPinStore(storage, machineId).compareAndSwap(undefined, trusted),
      createRelayPinStore(storage, machineId).compareAndSwap(undefined, { ...trusted, state: "recovery-required" }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("refuses a stored value that does not parse, for reads and for swaps over it", async () => {
    const storage = memoryStorage()
    storage.items.set(relayPinKey(machineId), "{not json")
    const store = createRelayPinStore(storage, machineId)
    await expect(store.read()).rejects.toThrow(/relay pin/)
    await expect(store.compareAndSwap(undefined, trusted)).rejects.toThrow(/relay pin/)
  })

  // The compare that decides is the storage's, on the bytes the swap's own
  // read returned. A swap whose read is stale by the time it reaches the
  // storage loses, whichever handle it came through.
  it("lets the storage refuse a swap whose read went stale under another handle", async () => {
    const storage = memoryStorage()
    storage.items.set(relayPinKey(machineId), JSON.stringify(trusted))
    const captured = gate(), resume = gate()
    let first = true
    const slow: RelayPinStorage = {
      ...storage,
      async read(key) {
        const raw = await storage.read(key)
        if (first) { first = false; captured.release(); await resume.promise }
        return raw
      },
    }
    const stale = createRelayPinStore(slow, machineId).compareAndSwap(trusted, { ...trusted, state: "recovery-required" })
    await captured.promise
    const successor = { ...trusted, identity: { ...trusted.identity, generation: 2, channel: { ...trusted.identity.channel, responderPublicKey: channelKey(11) } } }
    const fresh = createRelayPinStore(storage, machineId)
    expect(await fresh.compareAndSwap(trusted, successor)).toBe(true)
    resume.release()
    expect(await stale).toBe(false)
    expect(await fresh.read()).toEqual(successor)
  })

  it("refuses to enrol over a pin its storage could not read", async () => {
    const storage = memoryStorage()
    const recovery = { ...trusted, state: "recovery-required" as const }
    storage.items.set(relayPinKey(machineId), JSON.stringify(recovery))
    let failures = 1
    const flaky: RelayPinStorage = { ...storage, async read(key) { if (failures-- > 0) throw new Error("read denied"); return storage.read(key) } }
    const foreign = { ...trusted.identity, identityPublicKey: publicKey("ed25519", new Uint8Array(32).fill(31)), channel: { ...trusted.identity.channel, responderPublicKey: channelKey(29) } }
    const store = createRelayPinStore(flaky, machineId)
    await expect(reconcileRelayPin({ store, machineId, call: async () => ({ identity: foreign }) })).rejects.toThrow("read denied")
    expect(JSON.parse(storage.items.get(relayPinKey(machineId))!)).toEqual(recovery)
  })

  it("runs the protocol's recovery and adoption against key-value storage", async () => {
    const store = createRelayPinStore(memoryStorage(), machineId)
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
      const store = createRelayPinStore(memoryStorage(), machineId)
      const calls: string[] = []
      const call = async (method: string) => { calls.push(method); return publication(trusted) }
      expect(await reconcileRelayPin({ store, machineId, call })).toBe("enrolled")
      expect(await store.read()).toEqual(trusted)
      expect(await reconcileRelayPin({ store, machineId, call })).toBe("trusted")
      expect(calls).toEqual(["relay.recovery"])
    })

    it("leaves the client without a pin when the daemon refuses relay recovery", async () => {
      const store = createRelayPinStore(memoryStorage(), machineId)
      expect(await reconcileRelayPin({ store, machineId, call: async () => { throw new DaemonRpcError(-32602, "Relay recovery is unavailable") } })).toBe("unavailable")
      expect(await store.read()).toBeUndefined()
    })

    it.each([
      ["a request timeout", () => new DomovoiRpcTimeoutError("relay.recovery", "daemon", 30_000)],
      ["a closed connection", () => new Error("The daemon closed the connection")],
      ["a send failure", () => new TypeError("The request could not be sent")],
    ])("surfaces %s instead of calling it unavailable", async (_label, failure) => {
      const store = createRelayPinStore(memoryStorage(), machineId)
      const expected = failure()
      await expect(reconcileRelayPin({ store, machineId, call: async () => { throw failure() } })).rejects.toThrow(expected.message)
      expect(await store.read()).toBeUndefined()
    })

    it("recovers a distrusted pin from the fetched successor and refuses a fetch without one", async () => {
      const store = createRelayPinStore(memoryStorage(), machineId)
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

  it("keeps one pin per machine, so a different daemon starts with no pin", async () => {
    const storage = memoryStorage()
    await createRelayPinStore(storage, machineId).compareAndSwap(undefined, trusted)
    const otherMachine = `machine-${"b".repeat(32)}`
    const other = createRelayPinStore(storage, otherMachine)
    expect(await other.read()).toBeUndefined()
    const calls: string[] = []
    const call = async (method: string) => { calls.push(method); throw new DaemonRpcError(-32602, "Relay recovery is unavailable") }
    expect(await reconcileRelayPin({ store: other, machineId: otherMachine, call })).toBe("unavailable")
    expect(calls).toEqual(["relay.recovery"])
    expect(await createRelayPinStore(storage, machineId).read()).toEqual(trusted)
    await expect(other.compareAndSwap(undefined, trusted)).rejects.toThrow(/another machine/)
  })
})

// The browser's only durable home for a pin is localStorage. It is same-origin
// storage, so any script on this origin could rewrite it; that is the browser's
// trust boundary, and the pin only ever narrows what a relay may claim, it never
// grants anything. A missing or refusing storage is a failure to report, never
// an absent pin and never a crash out of a render.
describe("localStorage storage", () => {
  function fakeLocalStorage(): Storage & { store: Map<string, string> } {
    const store = new Map<string, string>()
    return {
      store,
      get length() { return store.size },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => [...store.keys()][index] ?? null,
      removeItem: (key) => { store.delete(key) },
      setItem: (key, value) => { store.set(key, value) },
    }
  }

  it("reads and writes through the Storage interface", async () => {
    const storage = localStorageRelayPinStorage(fakeLocalStorage())
    const store = createRelayPinStore(storage, machineId)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await store.read()).toEqual(trusted)
  })

  it("reports an unavailable localStorage on read and on swap, never as an absent pin", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError") } })
    try {
      let storage!: RelayPinStorage
      expect(() => { storage = localStorageRelayPinStorage() }).not.toThrow()
      await expect(storage.read(relayPinKey(machineId))).rejects.toThrow(/storage is unavailable/)
      await expect(storage.compareAndSwap(relayPinKey(machineId), undefined, "x")).rejects.toThrow(/storage is unavailable/)
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  it("surfaces a localStorage that refuses the read rather than reporting no pin", async () => {
    const broken = fakeLocalStorage()
    broken.getItem = () => { throw new DOMException("denied", "SecurityError") }
    const storage = localStorageRelayPinStorage(broken)
    await expect(storage.read(relayPinKey(machineId))).rejects.toThrow("denied")
  })

  it("compares the stored bytes under the swap, so a change since the read loses", async () => {
    const backing = fakeLocalStorage()
    const storage = localStorageRelayPinStorage(backing)
    const key = relayPinKey(machineId)
    expect(await storage.compareAndSwap(key, "stale", "next")).toBe(false)
    expect(backing.store.has(key)).toBe(false)
    expect(await storage.compareAndSwap(key, undefined, "first")).toBe(true)
    expect(await storage.compareAndSwap(key, undefined, "second")).toBe(false)
    expect(await storage.compareAndSwap(key, "first", "second")).toBe(true)
    expect(backing.store.get(key)).toBe("second")
  })

  it("holds a Web Lock named by the key around the compare and the write when the browser has one", async () => {
    const backing = fakeLocalStorage()
    const held: string[] = []
    const locks = { request: async (name: string, run: () => Promise<unknown>) => { held.push(name); return run() } }
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } })
    try {
      expect(await localStorageRelayPinStorage(backing).compareAndSwap(relayPinKey(machineId), undefined, "x")).toBe(true)
    } finally {
      Reflect.deleteProperty(globalThis, "navigator")
    }
    expect(held).toEqual([relayPinKey(machineId)])
  })
})

// The desktop's storage is a pair of bridge calls to the main process, which
// does the compare. An older desktop without them yields no storage, which the
// shell reads as "keep no pin".
describe("bridge storage", () => {
  it("wraps a bridge that has both calls and refuses one that lacks either", async () => {
    const calls: string[] = []
    const items = new Map<string, string>()
    const bridge = {
      readRelayPin: async (key: string) => { calls.push(`read ${key}`); return items.get(key) },
      swapRelayPin: async (key: string, expected: string | undefined, replacement: string) => {
        calls.push(`swap ${key} ${expected === undefined ? "absent" : "present"}`)
        if (items.get(key) !== expected) return false
        items.set(key, replacement)
        return true
      },
    }
    const storage = bridgeRelayPinStorage(bridge)!
    const store = createRelayPinStore(storage, machineId)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(true)
    expect(await store.read()).toEqual(trusted)
    expect(await store.compareAndSwap(undefined, trusted)).toBe(false)
    expect(calls.filter((call) => call.startsWith("swap"))).toEqual([`swap ${relayPinKey(machineId)} absent`])
    expect(bridgeRelayPinStorage({ readRelayPin: bridge.readRelayPin })).toBeUndefined()
    expect(bridgeRelayPinStorage(undefined)).toBeUndefined()
  })
})
