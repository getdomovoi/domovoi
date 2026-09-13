import type { KeychainAccessibilityConstant } from "expo-secure-store"
import { relayClientPinSchema, relayRecoveryResultSchema, type RelayClientPin } from "@getdomovoi/protocol"
import { adoptRelayRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"

// The three SecureStore calls this module uses, so tests can supply memory
// and the app supplies the Keychain or Keystore.
export type SecretItems = {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: KeychainAccessibilityConstant }): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

// One key per machine. A pin is a claim about one daemon's identity, so a
// phone paired with a different daemon must not find the previous one's pin
// under a shared key and take it as trusted.
export const relayPinKey = (machineId: string) => `domovoi.daemon.relayPin.${machineId}`

function parsePin(raw: string | null): RelayClientPin | undefined {
  if (raw === null) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error("The saved relay pin is not readable. Pair again to replace it.") }
  const parsed = relayClientPinSchema.safeParse(value)
  if (!parsed.success) throw new Error("The saved relay pin is not readable. Pair again to replace it.")
  return parsed.data
}

function canonical(pin: RelayClientPin | undefined): string | undefined {
  return pin === undefined ? undefined : JSON.stringify(relayClientPinSchema.parse(pin))
}

// Read-only. Safe from any process that shares the keychain, including a
// future notification extension: it may decide whether the pin is trusted,
// it may not change it.
export async function readRelayPin(secrets: SecretItems, machineId: string): Promise<RelayClientPin | undefined> {
  const pin = parsePin(await secrets.getItemAsync(relayPinKey(machineId)))
  if (pin !== undefined && pin.identity.machineId !== machineId) throw new Error("The saved relay pin belongs to another machine. Pair again to replace it.")
  return pin
}

export type PhoneRelayPinStore = Omit<RelayPinStore, "read" | "compareAndSwap"> & {
  read(): Promise<RelayClientPin | undefined>
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// One write queue per backing store and key, shared by every handle in the
// process. Keyed on the SecureStore object itself, so two createRelayPinStore
// calls over the same module cannot each pass the same compare.
const queues = new WeakMap<SecretItems, Map<string, Promise<unknown>>>()
function exclusive<T>(secrets: SecretItems, key: string, operation: () => Promise<T>): Promise<T> {
  let byKey = queues.get(secrets)
  if (!byKey) { byKey = new Map(); queues.set(secrets, byKey) }
  const tail = byKey.get(key) ?? Promise.resolve()
  const next = tail.then(operation, operation)
  byKey.set(key, next.catch(() => undefined))
  return next
}

// The writable store. SecureStore has no compare-and-swap, so the compare is
// done here under the shared queue and the write is confirmed by reading it
// back. That covers the app as shipped: one process, no extension, no second
// Android process. It does not cover a second process writing the same key.
// If a notification extension ever needs the pin, give it readRelayPin and
// keep every write in the app process, or this store's guarantee is gone.
export function createRelayPinStore(secrets: SecretItems, machineId: string, options: { keychainAccessible?: KeychainAccessibilityConstant } = {}): PhoneRelayPinStore {
  const key = relayPinKey(machineId)
  return {
    read: () => readRelayPin(secrets, machineId),
    async compareAndSwap(expected, replacement) {
      const parsed = relayClientPinSchema.parse(replacement)
      if (parsed.identity.machineId !== machineId) throw new Error("The relay pin belongs to another machine; it cannot be saved here.")
      const next = canonical(parsed)!
      return exclusive(secrets, key, async () => {
        if (canonical(await readRelayPin(secrets, machineId)) !== canonical(expected)) return false
        await secrets.setItemAsync(key, next, options)
        // The write already ran. Say the truth: it is unconfirmed, not absent.
        if (await secrets.getItemAsync(key) !== next) throw new Error("The relay pin write could not be confirmed; read the saved pin again before trusting or retrying.")
        return true
      })
    },
  }
}

export type RelayPinCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// Bring the saved pin in line with the daemon on the other end of an
// authenticated connection. No pin yet: enrol what this daemon publishes as
// trusted, because the token that opened this connection is what pairing
// proved. Recovery required: fetch the latest signed successor and adopt it
// against the saved pin, never the fetched identity. Trusted: nothing to do.
// A daemon without relay provisioning refuses relay.recovery; that leaves the
// pairing without a pin rather than failing it.
export async function reconcileRelayPin(input: {
  store: PhoneRelayPinStore
  machineId: string
  call: RelayPinCall
}): Promise<"trusted" | "enrolled" | "recovered" | "unavailable"> {
  const current = await input.store.read()
  if (current?.state === "trusted" && current.identity.machineId === input.machineId) return "trusted"
  let publication: unknown
  try { publication = await input.call("relay.recovery", { machineId: input.machineId }) } catch { return "unavailable" }
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
