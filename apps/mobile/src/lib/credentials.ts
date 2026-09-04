import * as SecureStore from "expo-secure-store"

export type DaemonCredential = { url: string, token: string }

const urlKey = "domovoi.daemon.url"
const tokenKey = "domovoi.daemon.token"

// The token is a daemon credential, so it goes to the Keychain rather than to
// ordinary storage. The address is not a secret, but it is kept beside the
// token so the two cannot get out of step.
export async function loadCredential(): Promise<DaemonCredential | undefined> {
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(urlKey),
    SecureStore.getItemAsync(tokenKey),
  ])
  if (!url || !token) return undefined
  return { url, token }
}

export async function saveCredential(credential: DaemonCredential): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(urlKey, credential.url),
    SecureStore.setItemAsync(tokenKey, credential.token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ])
}

export async function clearCredential(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(urlKey),
    SecureStore.deleteItemAsync(tokenKey),
  ])
}
