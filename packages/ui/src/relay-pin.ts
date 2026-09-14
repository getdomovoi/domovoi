import { relayClientPinSchema, relayRecoveryResultSchema, type RelayClientPin } from "@getdomovoi/protocol"
import { adoptRelayRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"

import { DaemonRpcError } from "./client.js"

// The two operations a pin store needs from whatever holds the bytes. The
// browser supplies localStorage; the desktop supplies a main-process file over
// its bridge; tests supply a Map. Nothing here is secret: a pin is the daemon's
// public relay identity plus whether this client still trusts it.
export type RelayPinStorage = {
  read(key: string): Promise<string | undefined>
  write(key: string, value: string): Promise<void>
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

export async function readRelayPin(storage: RelayPinStorage, machineId: string): Promise<RelayClientPin | undefined> {
  const pin = parsePin(await storage.read(relayPinKey(machineId)))
  if (pin !== undefined && pin.identity.machineId !== machineId) throw new Error("The saved relay pin belongs to another machine. Pair again to replace it.")
  return pin
}

export type ClientRelayPinStore = Omit<RelayPinStore, "read" | "compareAndSwap"> & {
  read(): Promise<RelayClientPin | undefined>
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// One write queue per backing storage and key, shared by every handle in the
// process. Keyed on the storage object itself, so two createRelayPinStore
// calls over the same storage cannot each pass the same compare.
const queues = new WeakMap<RelayPinStorage, Map<string, Promise<unknown>>>()
function exclusive<T>(storage: RelayPinStorage, key: string, operation: () => Promise<T>): Promise<T> {
  let byKey = queues.get(storage)
  if (!byKey) { byKey = new Map(); queues.set(storage, byKey) }
  const tail = byKey.get(key) ?? Promise.resolve()
  const next = tail.then(operation, operation)
  byKey.set(key, next.catch(() => undefined))
  return next
}

// Key-value storage has no compare-and-swap, so the compare is done here under
// the shared queue and the write is confirmed by reading it back. That covers
// one process. Two windows of the same origin, or two desktop renderers, are
// two processes; the browser's storage event and the desktop's single main
// process are what keep those honest, not this queue.
export function createRelayPinStore(storage: RelayPinStorage, machineId: string): ClientRelayPinStore {
  const key = relayPinKey(machineId)
  return {
    read: () => readRelayPin(storage, machineId),
    async compareAndSwap(expected, replacement) {
      const parsed = relayClientPinSchema.parse(replacement)
      if (parsed.identity.machineId !== machineId) throw new Error("The relay pin belongs to another machine; it cannot be saved here.")
      const next = canonical(parsed)!
      return exclusive(storage, key, async () => {
        if (canonical(await readRelayPin(storage, machineId)) !== canonical(expected)) return false
        await storage.write(key, next)
        // The write already ran. Say the truth: it is unconfirmed, not absent.
        if (await storage.read(key) !== next) throw new Error("The relay pin write could not be confirmed; read the saved pin again before trusting or retrying.")
        return true
      })
    },
  }
}

// localStorage is the browser's one durable, same-origin place for this. It
// can be absent (a worker, an opaque origin) or refuse (a private window that
// throws on access), and both read as "no saved pin": the client then enrols
// again on the next hello, which is the state a fresh install is in anyway. A
// write into an absent storage is refused rather than dropped silently.
export function localStorageRelayPinStorage(storage: Storage | undefined = globalThis.localStorage): RelayPinStorage {
  return {
    async read(key) {
      try { return storage?.getItem(key) ?? undefined } catch { return undefined }
    },
    async write(key, value) {
      if (!storage) throw new Error("The relay pin could not be saved: browser storage is unavailable.")
      storage.setItem(key, value)
    },
  }
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
