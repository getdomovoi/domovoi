import { relayClientPinSchema, relayRecoveryResultSchema, type RelayClientPin } from "@getdomovoi/protocol"
import { adoptRelayRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"

import { DaemonRpcError } from "./client.js"

// The two operations a pin store needs from whatever holds the bytes. The
// browser supplies localStorage; the desktop supplies a main-process file over
// its bridge; tests supply a Map. Nothing here is secret: a pin is the daemon's
// public relay identity plus whether this client still trusts it.
//
// The compare belongs to the storage, not to this package: the storage is the
// only place that can see every writer (every tab, every renderer), so it is
// the only place a compare-and-swap means anything. read returns undefined
// only when nothing is saved; a storage that cannot say must throw, because
// "unknown" read as "absent" would let a fresh enrolment replace a pin that is
// waiting for recovery.
export type RelayPinStorage = {
  read(key: string): Promise<string | undefined>
  compareAndSwap(key: string, expected: string | undefined, replacement: string): Promise<boolean>
}

// One key per machine. A pin is a claim about one daemon's identity, so a
// client attached to a different daemon must not find the previous one's pin
// under a shared key and take it as trusted.
export const relayPinKey = (machineId: string) => `domovoi.daemon.relayPin.${machineId}`

function parsePin(raw: string | undefined): RelayClientPin | undefined {
  if (raw === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error("The saved relay pin is not readable. Pair again to replace it.") }
  const parsed = relayClientPinSchema.safeParse(value)
  if (!parsed.success) throw new Error("The saved relay pin is not readable. Pair again to replace it.")
  return parsed.data
}

function canonical(pin: RelayClientPin | undefined): string | undefined {
  return pin === undefined ? undefined : JSON.stringify(relayClientPinSchema.parse(pin))
}

async function readRaw(storage: RelayPinStorage, machineId: string): Promise<{ raw: string | undefined; pin: RelayClientPin | undefined }> {
  const raw = await storage.read(relayPinKey(machineId))
  const pin = parsePin(raw)
  if (pin !== undefined && pin.identity.machineId !== machineId) throw new Error("The saved relay pin belongs to another machine. Pair again to replace it.")
  return { raw, pin }
}

export async function readRelayPin(storage: RelayPinStorage, machineId: string): Promise<RelayClientPin | undefined> {
  return (await readRaw(storage, machineId)).pin
}

export type ClientRelayPinStore = Omit<RelayPinStore, "read" | "compareAndSwap"> & {
  read(): Promise<RelayClientPin | undefined>
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// The pin compare is semantic (two encodings of one pin are equal); the
// storage compare is on the bytes this read returned. A swap that passes the
// first and fails the second lost a race to another writer, and says so.
export function createRelayPinStore(storage: RelayPinStorage, machineId: string): ClientRelayPinStore {
  const key = relayPinKey(machineId)
  return {
    read: () => readRelayPin(storage, machineId),
    async compareAndSwap(expected, replacement) {
      const parsed = relayClientPinSchema.parse(replacement)
      if (parsed.identity.machineId !== machineId) throw new Error("The relay pin belongs to another machine; it cannot be saved here.")
      const { raw, pin } = await readRaw(storage, machineId)
      if (canonical(pin) !== canonical(expected)) return false
      return storage.compareAndSwap(key, raw, canonical(parsed)!)
    },
  }
}

// localStorage is the browser's one durable, same-origin place for this. It
// can be absent (a worker, an opaque origin) or refuse (a private window that
// throws on access); both are reported as failures, never as "no saved pin".
// Discovery is deferred to the first call, so a refusing getter cannot throw
// out of a render. The compare and the write run under a Web Lock named by
// the key, which every tab of this origin shares; where Web Locks are missing
// a per-process lock covers the tabs this process has, which is all of them
// in the environments that lack it (tests, workers).
export function localStorageRelayPinStorage(storage?: Storage): RelayPinStorage {
  const resolve = (): Storage => {
    let found: Storage | undefined
    try { found = storage ?? globalThis.localStorage } catch { found = undefined }
    if (!found) throw new Error("The relay pin could not be read or saved: browser storage is unavailable.")
    return found
  }
  return {
    async read(key) {
      return resolve().getItem(key) ?? undefined
    },
    async compareAndSwap(key, expected, replacement) {
      const found = resolve()
      return withLock(key, async () => {
        if ((found.getItem(key) ?? undefined) !== expected) return false
        found.setItem(key, replacement)
        return true
      })
    },
  }
}

const localLocks = new Map<string, Promise<unknown>>()
function withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (locks) return locks.request(name, operation) as Promise<T>
  const tail = localLocks.get(name) ?? Promise.resolve()
  const next = tail.then(operation, operation)
  localLocks.set(name, next.catch(() => undefined))
  return next
}

// The desktop's storage is the main process's file, reached over the bridge.
// The main process does the compare, so two renderer windows cannot both pass
// it. A bridge without the two calls (an older desktop) means no pin is kept.
export type RelayPinBridge = {
  readRelayPin?(key: string): Promise<string | undefined>
  swapRelayPin?(key: string, expected: string | undefined, replacement: string): Promise<boolean>
}

export function bridgeRelayPinStorage(bridge: RelayPinBridge | undefined): RelayPinStorage | undefined {
  if (!bridge?.readRelayPin || !bridge.swapRelayPin) return undefined
  const read = bridge.readRelayPin.bind(bridge)
  const swap = bridge.swapRelayPin.bind(bridge)
  return { read: (key) => read(key), compareAndSwap: (key, expected, replacement) => swap(key, expected, replacement) }
}

export type RelayPinCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// Bring the saved pin in line with the daemon on the other end of an
// authenticated connection. No pin yet: enrol what this daemon publishes as
// trusted, because the token that opened this connection is what pairing
// proved. Recovery required: fetch the latest signed successor and adopt it
// against the saved pin, never the fetched identity. Trusted: nothing to do.
// A daemon refuses relay.recovery when it has no relay provisioning or when
// the caller's quota is spent; the two are not told apart here. A refusal
// leaves whatever pin is saved unchanged. A timeout, a closed socket or a
// failed send says nothing about the daemon, so those surface to the caller.
export async function reconcileRelayPin(input: {
  store: ClientRelayPinStore
  machineId: string
  call: RelayPinCall
}): Promise<"trusted" | "enrolled" | "recovered" | "unavailable"> {
  const current = await input.store.read()
  if (current?.state === "trusted" && current.identity.machineId === input.machineId) return "trusted"
  let publication: unknown
  try {
    publication = await input.call("relay.recovery", { machineId: input.machineId })
  } catch (error: unknown) {
    if (error instanceof DaemonRpcError) return "unavailable"
    throw error
  }
  const parsed = relayRecoveryResultSchema.parse(publication)
  if (parsed.identity.machineId !== input.machineId) throw new Error("The daemon published a relay identity for another machine.")
  if (current === undefined) {
    const enrolled = await input.store.compareAndSwap(undefined, { version: 1, identity: parsed.identity, state: "trusted" })
    if (!enrolled) throw new Error("The relay pin changed while enrolling; read it again.")
    return "enrolled"
  }
  await adoptRelayRecovery(input.store, parsed)
  return "recovered"
}
