import { relayClientPinSchema, type RelayClientPin } from "../src/relay-pin-recovery.js"
import { relayRecoveryResultSchema } from "../src/relay-recovery.js"

import { createRelayClient, type RelayClientOptions } from "./channel.js"
import { relayIdentityPublicKeyIsValid, verifyRelayChannelSuccessor } from "./identity.js"

export type RelayPinStore = {
  read(): Promise<unknown>
  // Atomically compare the whole record and durably replace it. Resolve true
  // only after persistence; false means another writer changed the saved pin.
  compareAndSwap(expected: RelayClientPin, replacement: RelayClientPin): Promise<boolean>
}

async function readPin(store: RelayPinStore): Promise<RelayClientPin> {
  const parsed = relayClientPinSchema.safeParse(await store.read())
  if (!parsed.success || !relayIdentityPublicKeyIsValid(parsed.data.identity.identityPublicKey)) throw new Error("Saved relay pin rejected")
  return parsed.data
}

async function replacePin(store: RelayPinStore, current: RelayClientPin, next: RelayClientPin): Promise<RelayClientPin> {
  if (!await store.compareAndSwap(current, next)) throw new Error("Relay pin changed during recovery")
  return next
}

export async function requireRelayPinRecovery(store: RelayPinStore): Promise<RelayClientPin> {
  const current = await readPin(store)
  if (current.state === "recovery-required") return current
  return replacePin(store, current, { ...current, state: "recovery-required" })
}

export async function adoptRelayPinSuccessor(store: RelayPinStore, envelope: unknown): Promise<RelayClientPin> {
  const current = await readPin(store)
  const identity = verifyRelayChannelSuccessor(current.identity, envelope)
  return replacePin(store, current, { version: 1, identity, state: "trusted" })
}

export async function adoptRelayRecovery(store: RelayPinStore, publication: unknown): Promise<RelayClientPin> {
  const current = await readPin(store)
  const result = relayRecoveryResultSchema.parse(publication)
  if (!result.successor) throw new Error("No relay successor is available")
  // The returned identity describes the envelope, but never supplies its trust
  // anchor. Both the signature and exact predecessor are checked against storage.
  const identity = verifyRelayChannelSuccessor(current.identity, result.successor)
  return replacePin(store, current, { version: 1, identity, state: "trusted" })
}

export type PinnedRelayClientOptions = Omit<RelayClientOptions, "context"> & { machineId: string; routeId: string }

// Read durable state for each new channel, never a caller-supplied channel pin.
// Existing channels and cross-process revocation remain the caller's lifecycle.
export async function createPinnedRelayClient(store: RelayPinStore, options: PinnedRelayClientOptions) {
  const pin = await readPin(store)
  if (pin.identity.machineId !== options.machineId) throw new Error("Relay pin belongs to another machine")
  if (pin.state !== "trusted") throw new Error("Relay pin recovery is required")
  return createRelayClient({ ...options, context: { relayProtocol: 1, routeId: options.routeId, channel: pin.identity.channel } })
}
