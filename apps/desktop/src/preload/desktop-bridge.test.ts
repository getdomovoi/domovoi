import { describe, expect, it, vi } from "vitest"

import { createDesktopWindowBridge, type IpcRendererAdapter } from "./desktop-bridge.js"

function ipc() {
  const handlers = new Map<string, (event: unknown, value: unknown) => void>()
  const target = {
    handlers,
    invoke: vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === "domovoi:open-directory") return { status: "selected", path: "/project" }
      if (channel === "domovoi:clipboard-read") return "clipboard"
      return true
    }),
    send: vi.fn((_channel: string, ..._args: unknown[]) => {}),
    on: vi.fn((channel, handler) => { handlers.set(channel, handler) }),
    removeListener: vi.fn((channel) => { handlers.delete(channel) }),
  }
  return target satisfies IpcRendererAdapter & { handlers: typeof handlers }
}

describe("createDesktopWindowBridge", () => {
  it("exposes typed narrow IPC methods instead of Electron", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.openDirectory()).resolves.toEqual({ status: "selected", path: "/project" })
    await expect(bridge.readClipboardText()).resolves.toBe("clipboard")
    await expect(bridge.writeClipboardText("copy me")).resolves.toBe(true)
    await expect(bridge.openExternal({ editor: "system", path: "/project" })).resolves.toBe(true)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:clipboard-write", "copy me")
    expect(target.invoke).toHaveBeenCalledWith("domovoi:open-external", { editor: "system", path: "/project" })
    expect(bridge).not.toHaveProperty("ipcRenderer")
    expect(bridge).not.toHaveProperty("shell")
    expect(bridge).not.toHaveProperty("clipboard")
  })

  it("hands the renderer the endpoint of the daemon the main process acquired", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const owned = { kind: "owned", url: "wss://[::1]:50123/rpc", token: "factory-token" }
    const attached = { kind: "attached", owner: "daemon", url: "ws://127.0.0.1:47831/rpc", token: "file-token" }

    target.invoke.mockResolvedValueOnce(owned)
    await expect(bridge.getRpcEndpoint()).resolves.toEqual({ url: "wss://[::1]:50123/rpc", token: "factory-token" })
    expect(target.invoke).toHaveBeenCalledWith("domovoi:rpc-endpoint")

    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.getRpcEndpoint()).resolves.toEqual({ url: "ws://127.0.0.1:47831/rpc", token: "file-token" })

    target.invoke.mockResolvedValueOnce(owned)
    await expect(bridge.acquireDaemon()).resolves.toEqual(owned)
    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.acquireDaemon()).resolves.toEqual(attached)
    expect(target.invoke).not.toHaveBeenCalledWith("domovoi:rpc-endpoint-reconnect")

    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.reacquireDaemon()).resolves.toEqual(attached)
    expect(target.invoke).toHaveBeenLastCalledWith("domovoi:rpc-endpoint-reconnect")
  })

  it("carries a refusal with the daemon's reason and message", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const refusal = { kind: "refused", reason: "owner-unreachable", message: "The profile has no reachable owner." }

    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.acquireDaemon()).resolves.toEqual(refusal)
    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.reacquireDaemon()).resolves.toEqual(refusal)
    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.getRpcEndpoint()).rejects.toThrow("The profile has no reachable owner.")
  })

  it("rejects a daemon acquisition that is not a described bearer token for a websocket URL", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    for (const reply of [
      "factory-token",
      null,
      [{ kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" }],
      { url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "started", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc" },
      { kind: "owned", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t".repeat(4_097) },
      { kind: "owned", url: "", token: "factory-token" },
      { kind: "owned", url: "http://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "owned", url: "not a url", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "factory-token", host: "127.0.0.1" },
      { kind: "owned", owner: "daemon", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", owner: "service", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", owner: "daemon", url: "http://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "refused", reason: "owner-unreachable" },
      { kind: "refused", reason: "owner-unreachable", message: "" },
      { kind: "refused", reason: "owner-unreachable", message: "m".repeat(1_001) },
      { kind: "refused", reason: "owner-asleep", message: "The profile has no reachable owner." },
      { kind: "refused", reason: "owner-unreachable", message: "The profile has no reachable owner.", url: "ws://127.0.0.1:47831/rpc" },
    ]) {
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.acquireDaemon()).rejects.toThrow("Desktop returned an invalid daemon endpoint")
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.getRpcEndpoint()).rejects.toThrow("Desktop returned an invalid daemon endpoint")
    }
  })

  it("validates renderer inputs before IPC", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "win32")
    await expect(bridge.writeClipboardText("x".repeat(1_000_001))).rejects.toThrow("Clipboard text is too large")
    await expect(bridge.openExternal({ editor: "system", path: "relative" })).rejects.toThrow(
      "External editor request is invalid",
    )
    expect(target.invoke).not.toHaveBeenCalledWith("domovoi:clipboard-write", expect.anything())
  })

  it("reports the running window decoration and refuses unknown values", async () => {
    const decorations: unknown[] = ["system", "gnome"]
    const target = {
      invoke: vi.fn(async () => decorations.shift()),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } satisfies IpcRendererAdapter
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.getWindowDecoration()).resolves.toBe("system")
    await expect(bridge.getWindowDecoration()).rejects.toThrow(
      "Desktop returned an invalid window decoration",
    )
  })

  it("validates a window decoration before persisting it", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.setWindowDecoration("system")).resolves.toBe(true)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:window-decoration-set", "system")

    await expect(
      bridge.setWindowDecoration("gnome" as never),
    ).rejects.toThrow("Window decoration is invalid")
    expect(target.invoke).toHaveBeenCalledTimes(1)
  })

  it("validates annotation capture replies before they reach the renderer", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const rect = { x: 0, y: 0, width: 320, height: 120 }
    const capture = { mimeType: "image/png", width: 320, height: 120, data: "AAAA" }

    target.invoke.mockResolvedValueOnce(capture)
    await expect(bridge.captureAnnotation(rect)).resolves.toEqual(capture)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:capture-annotation", rect)

    for (const reply of [
      "AAAA",
      null,
      [capture],
      { mimeType: "image/jpeg", width: 320, height: 120, data: "AAAA" },
      { mimeType: "image/jpeg" },
      { mimeType: "image/png", width: 0, height: 120, data: "AAAA" },
      { mimeType: "image/png", width: 320, height: 2049, data: "AAAA" },
      { mimeType: "image/png", width: 320.5, height: 120, data: "AAAA" },
      { mimeType: "image/png", width: 320, height: 120, data: "" },
      { mimeType: "image/png", width: 320, height: 120, data: "A".repeat(2_000_001) },
      { mimeType: "image/png", width: 320, height: 120, data: "AAAA", extra: true },
    ]) {
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.captureAnnotation(rect)).rejects.toThrow(
        "Desktop returned an invalid annotation capture response",
      )
    }
  })

  it("routes only bounded deep-link session IDs and removes its listener", () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "darwin")
    const listener = vi.fn()
    const dispose = bridge.onDeepLink(listener)
    expect(target.send).toHaveBeenCalledWith("domovoi:deep-link-ready")

    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "session-one")
    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "../private")
    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "a".repeat(129))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith("session-one")

    dispose()
    expect(target.send).toHaveBeenCalledWith("domovoi:deep-link-paused")
    expect(target.removeListener).toHaveBeenCalledWith("domovoi:deep-link", expect.any(Function))
  })
})
