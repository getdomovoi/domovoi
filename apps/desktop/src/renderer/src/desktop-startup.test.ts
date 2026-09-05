import { describe, expect, it, vi } from "vitest"

import { desktopRpcEndpointResolver, resolveDesktopStartup } from "./desktop-startup.js"

describe("desktopRpcEndpointResolver", () => {
  const startup = { rpcUrl: "ws://127.0.0.1:47831/rpc", rpcToken: "file-token" }

  it("answers from the cached endpoint while this app owns the daemon", async () => {
    const reacquireDaemon = vi.fn()
    const resolve = desktopRpcEndpointResolver({ ...startup, daemon: { kind: "owned" } }, { reacquireDaemon })

    await expect(resolve()).resolves.toEqual({ url: "ws://127.0.0.1:47831/rpc", token: "file-token" })
    expect(reacquireDaemon).not.toHaveBeenCalled()
  })

  it("re-acquires through the main process while attached and hands over the fresh endpoint", async () => {
    const reacquireDaemon = vi.fn(async () => ({
      kind: "attached" as const,
      owner: "daemon" as const,
      url: "wss://localhost:50123/rpc",
      token: "rotated-token",
    }))
    const resolve = desktopRpcEndpointResolver({ ...startup, daemon: { kind: "attached", owner: "daemon" } }, { reacquireDaemon })

    await expect(resolve()).resolves.toEqual({ url: "wss://localhost:50123/rpc", token: "rotated-token" })
    await expect(resolve()).resolves.toEqual({ url: "wss://localhost:50123/rpc", token: "rotated-token" })
    expect(reacquireDaemon).toHaveBeenCalledTimes(2)
  })

  it("turns a refusal into the reconnect failure carrying the daemon's message", async () => {
    const reacquireDaemon = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "owner-unreachable" as const,
      message: "The profile has no reachable owner.",
    }))
    const resolve = desktopRpcEndpointResolver({ ...startup, daemon: { kind: "attached", owner: "desktop" } }, { reacquireDaemon })

    await expect(resolve()).rejects.toThrow("The profile has no reachable owner.")
  })
})

describe("resolveDesktopStartup", () => {
  it("connects to the URL and token of the daemon this app owns, not a fixed address", async () => {
    const acquireDaemon = vi.fn(async () => ({
      kind: "owned" as const,
      url: "wss://[::1]:50123/rpc",
      token: "factory-token",
    }))

    await expect(resolveDesktopStartup({ domovoiDesktop: { acquireDaemon } })).resolves.toEqual({
      kind: "workspace",
      rpcUrl: "wss://[::1]:50123/rpc",
      rpcToken: "factory-token",
      daemon: { kind: "owned" },
    })
  })

  it("connects to the owner it attached to and remembers who owns it", async () => {
    for (const owner of ["daemon", "desktop"] as const) {
      const acquireDaemon = vi.fn(async () => ({
        kind: "attached" as const,
        owner,
        url: "ws://127.0.0.1:47831/rpc",
        token: "file-token",
      }))

      await expect(resolveDesktopStartup({ domovoiDesktop: { acquireDaemon } })).resolves.toEqual({
        kind: "workspace",
        rpcUrl: "ws://127.0.0.1:47831/rpc",
        rpcToken: "file-token",
        daemon: { kind: "attached", owner },
      })
    }
  })

  it("carries a refusal with the daemon's reason and message instead of a workspace", async () => {
    const acquireDaemon = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "owner-unreachable" as const,
      message: "The profile has no reachable owner.",
    }))

    await expect(resolveDesktopStartup({ domovoiDesktop: { acquireDaemon } })).resolves.toEqual({
      kind: "refused",
      reason: "owner-unreachable",
      message: "The profile has no reachable owner.",
    })
  })

  it("finishes the launch smoke before asking for daemon credentials", async () => {
    const acquireDaemon = vi.fn(async () => ({
      kind: "owned" as const,
      url: "ws://127.0.0.1:47831/rpc",
      token: "factory-token",
    }))

    await expect(resolveDesktopStartup({
      domovoiDesktop: { acquireDaemon },
      domovoiLaunchSmoke: { ready: () => {} },
    })).resolves.toEqual({ kind: "launch-smoke" })
    expect(acquireDaemon).not.toHaveBeenCalled()
  })

  it("fails without the preload bridge", async () => {
    await expect(resolveDesktopStartup({})).rejects.toThrow("Desktop bridge is unavailable")
  })

  it("surfaces a rejected acquisition as the startup failure", async () => {
    const acquireDaemon = vi.fn(async () => { throw new Error("Desktop request is not authorized") })

    await expect(resolveDesktopStartup({ domovoiDesktop: { acquireDaemon } }))
      .rejects.toThrow("Desktop request is not authorized")
  })
})
