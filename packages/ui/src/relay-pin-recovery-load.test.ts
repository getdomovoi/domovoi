import type { RelayClientPin } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { RelayPinStorage } from "./relay-pin"

// The relay recovery code (the signature checks and the curve library under
// them) loads only when a distrusted pin is recovered, so a client that
// enrols or keeps a trusted pin never downloads it. Its own file, because the
// recovery module is held back for every import here.

const load = vi.hoisted(() => ({ requests: 0, fails: false }))

beforeEach(() => {
  load.requests = 0
  load.fails = false
  vi.resetModules()
  vi.doMock("@getdomovoi/protocol/relay-admission", async (importOriginal: () => Promise<unknown>) => {
    load.requests += 1
    if (load.fails) throw new Error("Failed to fetch dynamically imported module")
    return importOriginal()
  })
})

afterEach(() => {
  vi.doUnmock("@getdomovoi/protocol/relay-admission")
})

function memoryStorage(): RelayPinStorage {
  const items = new Map<string, string>()
  return {
    async read(key) { return items.get(key) },
    async compareAndSwap(key, expected, replacement) {
      if (items.get(key) !== expected) return false
      items.set(key, replacement)
      return true
    },
  }
}

const machineId = `machine-${"a".repeat(32)}`
const trusted: RelayClientPin = {
  version: 1, state: "trusted",
  identity: { version: 1, machineId, identityPublicKey: `${"B".repeat(42)}A`, generation: 1, channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: `${"C".repeat(42)}A` } },
}
const publication = { identity: trusted.identity }

it("enrols a pin and keeps a trusted one without loading the recovery code", async () => {
  const { createRelayPinStore, reconcileRelayPin } = await import("./relay-pin")
  const store = createRelayPinStore(memoryStorage(), machineId)
  expect(await reconcileRelayPin({ store, machineId, call: async () => publication })).toBe("enrolled")
  expect(await reconcileRelayPin({ store, machineId, call: async () => publication })).toBe("trusted")
  expect(load.requests).toBe(0)
})

it("leaves a distrusted pin as it was when the recovery code does not load", async () => {
  const { createRelayPinStore, reconcileRelayPin } = await import("./relay-pin")
  const store = createRelayPinStore(memoryStorage(), machineId)
  const distrusted: RelayClientPin = { ...trusted, state: "recovery-required" }
  expect(await store.compareAndSwap(undefined, distrusted)).toBe(true)
  load.fails = true
  // The runner wraps a failed load in its own error and keeps the load's
  // failure as the cause.
  await expect(reconcileRelayPin({ store, machineId, call: async () => publication })).rejects.toMatchObject({
    cause: expect.objectContaining({ message: "Failed to fetch dynamically imported module" }),
  })
  expect(load.requests).toBe(1)
  expect(await store.read()).toEqual(distrusted)
})
