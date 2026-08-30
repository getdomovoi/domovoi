import { createRequire } from "node:module"

const providers = ["anthropic", "openai", "openrouter"] as const
export type DirectApiProvider = typeof providers[number]

export type ProviderSecretStatus = {
  provider: DirectApiProvider
  state: "stored" | "not-set" | "unavailable"
  source: "keychain"
}

export interface ProviderKeyring {
  get(account: string): string | undefined
  set(account: string, secret: string): void
  delete(account: string): unknown
}

export class ProviderSecretUnavailableError extends Error {}

export class ProviderSecretManager {
  readonly #keyring: ProviderKeyring

  constructor(keyring: ProviderKeyring = new NativeProviderKeyring()) {
    this.#keyring = keyring
  }

  status(): ProviderSecretStatus[] {
    return providers.map((provider) => {
      try {
        return {
          provider,
          state: this.#keyring.get(provider) ? "stored" : "not-set",
          source: "keychain",
        }
      } catch {
        return { provider, state: "unavailable", source: "keychain" }
      }
    })
  }

  set(provider: string, secret: string): void {
    const supported = requireProvider(provider)
    if (!secret.trim()) throw new Error("Provider key cannot be empty")
    try {
      this.#keyring.set(supported, secret)
    } catch {
      throw new ProviderSecretUnavailableError("OS keychain is unavailable on this machine")
    }
  }

  delete(provider: string): void {
    const supported = requireProvider(provider)
    try {
      this.#keyring.delete(supported)
    } catch {
      throw new ProviderSecretUnavailableError("OS keychain is unavailable on this machine")
    }
  }

  forExecution(provider: string): string | undefined {
    const supported = requireProvider(provider)
    try {
      return this.#keyring.get(supported)
    } catch {
      throw new ProviderSecretUnavailableError("OS keychain is unavailable on this machine")
    }
  }
}

type KeyringEntry = {
  getPassword(): string | null
  setPassword(secret: string): void
  deletePassword(): unknown
}

type KeyringBinding = {
  Entry: new (service: string, account: string) => KeyringEntry
}

export type KeyringBindingLoader = () => KeyringBinding

const require = createRequire(import.meta.url)
const loadNativeBinding: KeyringBindingLoader = () =>
  require("@napi-rs/keyring") as KeyringBinding

export class NativeProviderKeyring implements ProviderKeyring {
  readonly #loadBinding: KeyringBindingLoader
  #binding: KeyringBinding | undefined
  #loadFailed = false

  constructor(loadBinding: KeyringBindingLoader = loadNativeBinding) {
    this.#loadBinding = loadBinding
  }

  get(account: string): string | undefined {
    return new (this.#requireBinding().Entry)(
      "domovoi.provider-api-key",
      account,
    ).getPassword() ?? undefined
  }

  set(account: string, secret: string): void {
    new (this.#requireBinding().Entry)("domovoi.provider-api-key", account).setPassword(secret)
  }

  delete(account: string): void {
    new (this.#requireBinding().Entry)("domovoi.provider-api-key", account).deletePassword()
  }

  #requireBinding(): KeyringBinding {
    if (this.#binding) return this.#binding
    if (this.#loadFailed) throw new Error("OS keychain binding is unavailable")
    try {
      this.#binding = this.#loadBinding()
      return this.#binding
    } catch {
      this.#loadFailed = true
      throw new Error("OS keychain binding is unavailable")
    }
  }
}

function requireProvider(provider: string): DirectApiProvider {
  if ((providers as readonly string[]).includes(provider)) return provider as DirectApiProvider
  throw new Error(`Unsupported direct API provider: ${provider}`)
}
