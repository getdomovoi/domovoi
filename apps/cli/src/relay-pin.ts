import { relayClientPinSchema, type RelayClientPin } from "@getdomovoi/protocol"
import type { RelayPinStore } from "@getdomovoi/protocol/relay-admission"

import type { CredentialStore } from "./credentials.js"

// Pins compare by value. Two records that serialise the same are the same pin.
function samePin(left: RelayClientPin | undefined, right: RelayClientPin | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return JSON.stringify(relayClientPinSchema.parse(left)) === JSON.stringify(relayClientPinSchema.parse(right))
}

export type CliRelayPinStore = RelayPinStore & {
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// The pin for one paired daemon, kept on its pairing record. Enrollment passes
// undefined as the expected value; recovery and adoption pass the pin they
// read. A swap against anything but the saved value is refused, not merged.
export function relayPinStore(store: CredentialStore, endpoint: string): CliRelayPinStore {
  return {
    async read() {
      return (await store.load(endpoint))?.relayPin
    },
    async compareAndSwap(expected, replacement) {
      const next = relayClientPinSchema.parse(replacement)
      let paired = true
      const updated = await store.update(endpoint, (current) => {
        if (current === undefined) { paired = false; return undefined }
        if (!samePin(current.relayPin, expected)) return undefined
        return { ...current, relayPin: next }
      })
      if (!paired) throw new Error(`This client is not paired with ${endpoint}; pair first, then the relay pin can be saved.`)
      return updated
    },
  }
}
