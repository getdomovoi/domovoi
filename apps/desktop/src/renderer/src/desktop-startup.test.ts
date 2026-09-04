import { describe, expect, it, vi } from "vitest"

import { resolveDesktopStartup } from "./desktop-startup.js"

describe("resolveDesktopStartup", () => {
  it("connects to the URL and token the main process resolved, not a fixed address", async () => {
    const getRpcEndpoint = vi.fn(async () => ({ url: "wss://[::1]:50123/rpc", token: "factory-token" }))

    await expect(resolveDesktopStartup({ domovoiDesktop: { getRpcEndpoint } })).resolves.toEqual({
      kind: "workspace",
      rpcUrl: "wss://[::1]:50123/rpc",
      rpcToken: "factory-token",
    })
  })

  it("finishes the launch smoke before asking for daemon credentials", async () => {
    const getRpcEndpoint = vi.fn(async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "factory-token" }))

    await expect(resolveDesktopStartup({
      domovoiDesktop: { getRpcEndpoint },
      domovoiLaunchSmoke: { ready: () => {} },
    })).resolves.toEqual({ kind: "launch-smoke" })
    expect(getRpcEndpoint).not.toHaveBeenCalled()
  })

  it("fails without the preload bridge", async () => {
    await expect(resolveDesktopStartup({})).rejects.toThrow("Desktop bridge is unavailable")
  })

  it("surfaces a refused endpoint as the startup failure", async () => {
    const getRpcEndpoint = vi.fn(async () => { throw new Error("Desktop request is not authorized") })

    await expect(resolveDesktopStartup({ domovoiDesktop: { getRpcEndpoint } }))
      .rejects.toThrow("Desktop request is not authorized")
  })
})
