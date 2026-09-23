import { beforeEach, describe, expect, it, jest } from "@jest/globals"

import { clearCredential, loadCredential, saveCredential } from "./credentials"

const mockHeld = new Map<string, string>()

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => mockHeld.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockHeld.set(key, value) },
  deleteItemAsync: async (key: string) => { mockHeld.delete(key) },
}))

beforeEach(() => { mockHeld.clear() })

describe("the stored daemon credential", () => {
  it("keeps the kind a tablet code paired, so the next launch greets as a tablet", async () => {
    await saveCredential({ url: "wss://desk/rpc", token: "t".repeat(43), client: "tablet" })

    await expect(loadCredential()).resolves.toEqual({ url: "wss://desk/rpc", token: "t".repeat(43), client: "tablet" })
  })

  it("reads a credential stored before the kind was kept as a phone's, the only kind that connected then", async () => {
    mockHeld.set("domovoi.daemon.url", "wss://desk/rpc")
    mockHeld.set("domovoi.daemon.token", "t".repeat(43))

    await expect(loadCredential()).resolves.toEqual({ url: "wss://desk/rpc", token: "t".repeat(43), client: "phone" })
  })

  it("forgets the kind with the rest of the credential", async () => {
    await saveCredential({ url: "wss://desk/rpc", token: "t".repeat(43), client: "tablet" })
    await clearCredential()

    expect(mockHeld.size).toBe(0)
  })
})
