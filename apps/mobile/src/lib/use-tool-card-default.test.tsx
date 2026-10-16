import { beforeEach, describe, expect, it, jest } from "@jest/globals"
import { act, renderHook, waitFor } from "@testing-library/react-native"

import { useToolCardDefault } from "./use-tool-card-default"

const mockHeld = new Map<string, string>()

jest.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mockHeld.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockHeld.set(key, value) },
}))

describe("useToolCardDefault", () => {
  beforeEach(() => mockHeld.clear())

  it("starts collapsed on a fresh install", async () => {
    const hook = await renderHook(() => useToolCardDefault())
    expect(hook.result.current[0]).toBe("collapsed")
  })

  it("reads the choice this device saved", async () => {
    mockHeld.set("domovoi.tool-cards", "expanded")
    const hook = await renderHook(() => useToolCardDefault())
    await waitFor(() => expect(hook.result.current[0]).toBe("expanded"))
  })

  it("ignores a stored value it does not know", async () => {
    mockHeld.set("domovoi.tool-cards", "sideways")
    const hook = await renderHook(() => useToolCardDefault())
    await act(async () => { await Promise.resolve() })
    expect(hook.result.current[0]).toBe("collapsed")
  })

  it("keeps a new choice on the device", async () => {
    const hook = await renderHook(() => useToolCardDefault())
    await act(async () => { hook.result.current[1]("expanded") })
    expect(hook.result.current[0]).toBe("expanded")
    expect(mockHeld.get("domovoi.tool-cards")).toBe("expanded")
  })
})
