import { describe, expect, it, vi } from "vitest"

import { ProviderSecretManager, ProviderSecretUnavailableError } from "./provider-secrets.js"

class MemoryKeyring {
  readonly values = new Map<string, string>()
  get = vi.fn((account: string) => this.values.get(account))
  set = vi.fn((account: string, secret: string) => { this.values.set(account, secret) })
  delete = vi.fn((account: string) => this.values.delete(account))
}

describe("ProviderSecretManager", () => {
  it("stores provider keys in the OS keyring and only reports status", () => {
    const keyring = new MemoryKeyring()
    const manager = new ProviderSecretManager(keyring)

    manager.set("openai", "sk-top-secret")

    expect(manager.status()).toEqual([
      { provider: "anthropic", state: "not-set", source: "keychain" },
      { provider: "openai", state: "stored", source: "keychain" },
      { provider: "openrouter", state: "not-set", source: "keychain" },
    ])
    expect(keyring.set).toHaveBeenCalledWith("openai", "sk-top-secret")
    expect(JSON.stringify(manager.status())).not.toContain("sk-top-secret")
  })

  it("rejects empty secrets and unknown providers", () => {
    const manager = new ProviderSecretManager(new MemoryKeyring())
    expect(() => manager.set("openai", "  ")).toThrow("Provider key cannot be empty")
    expect(() => manager.set("xai", "secret")).toThrow("Unsupported direct API provider")
  })

  it("deletes keys without returning their prior value", () => {
    const keyring = new MemoryKeyring()
    keyring.values.set("anthropic", "secret")
    const manager = new ProviderSecretManager(keyring)

    expect(manager.delete("anthropic")).toBeUndefined()
    expect(manager.status()).toContainEqual({
      provider: "anthropic",
      state: "not-set",
      source: "keychain",
    })
  })

  it("fails closed when the native keychain is unavailable", () => {
    const keyring = new MemoryKeyring()
    keyring.get.mockImplementation(() => { throw new Error("No Secret Service") })
    keyring.set.mockImplementation(() => { throw new Error("No Secret Service") })
    const manager = new ProviderSecretManager(keyring)

    expect(manager.status()).toEqual([
      { provider: "anthropic", state: "unavailable", source: "keychain" },
      { provider: "openai", state: "unavailable", source: "keychain" },
      { provider: "openrouter", state: "unavailable", source: "keychain" },
    ])
    expect(() => manager.set("openai", "secret")).toThrow(ProviderSecretUnavailableError)
  })

  it("allows secret reads only through the execution-only method", () => {
    const keyring = new MemoryKeyring()
    keyring.values.set("openrouter", "execution-secret")
    const manager = new ProviderSecretManager(keyring)

    expect(manager.forExecution("openrouter")).toBe("execution-secret")
    expect(Object.keys(manager.status()[0]!)).not.toContain("secret")
  })
})
