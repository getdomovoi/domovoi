import { relayClientPinSchema, relayRecoveryResultSchema, type RelayClientPin } from "@getdomovoi/protocol"
import { adoptRelayRecovery, type RelayPinStore } from "@getdomovoi/protocol/relay-admission"

import type { CredentialStore } from "./credentials.js"

// Pins compare by value. Two records that serialise the same are the same pin.
function samePin(left: RelayClientPin | undefined, right: RelayClientPin | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return JSON.stringify(relayClientPinSchema.parse(left)) === JSON.stringify(relayClientPinSchema.parse(right))
}

export type CliRelayPinStore = Omit<RelayPinStore, "read" | "compareAndSwap"> & {
  read(): Promise<RelayClientPin | undefined>
  compareAndSwap(expected: RelayClientPin | undefined, replacement: RelayClientPin): Promise<boolean>
}

// The pin for one paired daemon, kept on its pairing record. Enrollment passes
// undefined as the expected value; recovery and adoption pass the pin they
// read. A swap against anything but the saved value is refused, not merged.
// The compare and the write happen under the store's lock, so two handles or
// two processes cannot both pass the same compare.
export function relayPinStore(store: CredentialStore, endpoint: string): CliRelayPinStore {
  return {
    async read(): Promise<RelayClientPin | undefined> {
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

export type RelayPinCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// Bring the saved pin in line with the daemon on the other end of an
// authenticated connection. No pin yet: enrol what this daemon publishes as
// trusted, because the bearer that opened this connection is what pairing
// proved. Recovery required: fetch the latest signed successor and adopt it
// against the saved pin, never the fetched identity. Trusted: nothing to do.
// A daemon without relay provisioning answers relay.recovery with a refusal;
// that leaves the pairing without a pin rather than failing it.
export async function reconcileRelayPin(input: {
  store: CredentialStore
  endpoint: string
  machineId: string
  call: RelayPinCall
}): Promise<"trusted" | "enrolled" | "recovered" | "unavailable"> {
  const pins = relayPinStore(input.store, input.endpoint)
  const current = await pins.read()
  if (current?.state === "trusted") return "trusted"
  let publication: unknown
  try { publication = await input.call("relay.recovery", { machineId: input.machineId }) } catch { return "unavailable" }
  const parsed = relayRecoveryResultSchema.parse(publication)
  if (parsed.identity.machineId !== input.machineId) throw new Error("The daemon published a relay identity for another machine.")
  if (current === undefined) {
    const enrolled = await pins.compareAndSwap(undefined, { version: 1, identity: parsed.identity, state: "trusted" })
    if (!enrolled) throw new Error("The relay pin changed while enrolling; read it again.")
    return "enrolled"
  }
  await adoptRelayRecovery(pins, parsed)
  return "recovered"
}
