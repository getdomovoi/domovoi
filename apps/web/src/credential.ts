const daemonCredentialKey = "domovoi.daemon-credential"

type CredentialStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">

export function loadDaemonCredential(storage: CredentialStorage): string {
  return storage.getItem(daemonCredentialKey)?.trim() ?? ""
}

export function saveDaemonCredential(storage: CredentialStorage, credential: string): void {
  storage.setItem(daemonCredentialKey, credential.trim())
}

export function clearDaemonCredential(storage: CredentialStorage): void {
  storage.removeItem(daemonCredentialKey)
}
