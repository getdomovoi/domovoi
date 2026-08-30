import { Entry } from "@napi-rs/keyring"

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

class NativeProviderKeyring implements ProviderKeyring {
  get(account: string): string | undefined {
    return new Entry("domovoi.provider-api-key", account).getPassword() ?? undefined
  }

  set(account: string, secret: string): void {
    new Entry("domovoi.provider-api-key", account).setPassword(secret)
  }

  delete(account: string): void {
    new Entry("domovoi.provider-api-key", account).deletePassword()
  }
}

function requireProvider(provider: string): DirectApiProvider {
  if ((providers as readonly string[]).includes(provider)) return provider as DirectApiProvider
  throw new Error(`Unsupported direct API provider: ${provider}`)
}
