import { describe, expect, it } from "vitest"

import {
  clearDaemonCredential,
  loadDaemonCredential,
  saveDaemonCredential,
} from "./credential"

class MemoryStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe("browser daemon credentials", () => {
  it("keeps the credential in session storage and can forget it", () => {
    const storage = new MemoryStorage()

    saveDaemonCredential(storage, "  token-value  ")
    expect(loadDaemonCredential(storage)).toBe("token-value")
    clearDaemonCredential(storage)
    expect(loadDaemonCredential(storage)).toBe("")
  })
})
