import * as SecureStore from "expo-secure-store"

import { legacyHandheldClient, type HandheldClient } from "./protocol-facts"
import { createRelayPinStore, type PhoneRelayPinStore } from "./relay-pin"

export type DaemonCredential = { url: string, token: string, client: HandheldClient }

const urlKey = "domovoi.daemon.url"
const tokenKey = "domovoi.daemon.token"
const clientKey = "domovoi.daemon.client"

// The token is a daemon credential, so it goes to the Keychain rather than to
// ordinary storage. The address is not a secret, but it is kept beside the
// token so the two cannot get out of step.
export async function loadCredential(): Promise<DaemonCredential | undefined> {
  const [url, token, client] = await Promise.all([
    SecureStore.getItemAsync(urlKey),
    SecureStore.getItemAsync(tokenKey),
    SecureStore.getItemAsync(clientKey),
  ])
  if (!url || !token) return undefined
  return { url, token, client: client === "tablet" || client === "phone" ? client : legacyHandheldClient }
}

export async function saveCredential(credential: DaemonCredential): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(urlKey, credential.url),
    SecureStore.setItemAsync(clientKey, credential.client),
    SecureStore.setItemAsync(tokenKey, credential.token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ])
}

export async function clearCredential(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(urlKey),
    SecureStore.deleteItemAsync(tokenKey),
    SecureStore.deleteItemAsync(clientKey),
  ])
}

// App-process wiring for the relay pin. Nothing else constructs a writable
// store; see relay-pin.ts for why that matters once an extension exists.
export function openRelayPinStore(machineId: string): PhoneRelayPinStore {
  return createRelayPinStore(SecureStore, machineId, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
}
