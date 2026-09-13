import type { KeychainAccessibilityConstant } from "expo-secure-store"
import { relayClientPinSchema, type RelayClientPin } from "@getdomovoi/protocol"
import type { RelayPinStore } from "@getdomovoi/protocol/relay-admission"

// The three SecureStore calls this module uses, so tests can supply memory
// and the app supplies the Keychain or Keystore.
export type SecretItems = {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: KeychainAccessibilityConstant }): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

export const relayPinKey = "domovoi.daemon.relayPin"

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
export async function readRelayPin(secrets: SecretItems): Promise<RelayClientPin | undefined> {
  return parsePin(await secrets.getItemAsync(relayPinKey))
}

export type PhoneRelayPinStore = RelayPinStore & {
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// The writable store. SecureStore has no compare-and-swap, so the compare is
// done here under an in-process queue and the write is confirmed by reading
// it back. That covers the app as shipped: one process, no extension, no
// second Android process. It does not cover a second process writing the same
// key. If a notification extension ever needs the pin, give it readRelayPin
// and keep every write in the app process, or this store's guarantee is gone.
export function createRelayPinStore(secrets: SecretItems, options: { keychainAccessible?: KeychainAccessibilityConstant } = {}): PhoneRelayPinStore {
  let tail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation)
    tail = next.catch(() => undefined)
    return next
  }
  return {
    read: () => readRelayPin(secrets),
    compareAndSwap(expected, replacement) {
      const next = canonical(replacement)!
      return exclusive(async () => {
        if (canonical(await readRelayPin(secrets)) !== canonical(expected)) return false
        await secrets.setItemAsync(relayPinKey, next, options)
        if (await secrets.getItemAsync(relayPinKey) !== next) throw new Error("The relay pin read-back did not match what was written; nothing was adopted.")
        return true
      })
    },
  }
}
