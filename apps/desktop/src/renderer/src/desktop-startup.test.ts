import { describe, expect, it, vi } from "vitest"

import { resolveDesktopStartup } from "./desktop-startup.js"

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
