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

  it("validates renderer inputs before IPC", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "win32")
    await expect(bridge.writeClipboardText("x".repeat(1_000_001))).rejects.toThrow("Clipboard text is too large")
    await expect(bridge.openExternal({ editor: "system", path: "relative" })).rejects.toThrow(
      "External editor request is invalid",
    )
    expect(target.invoke).not.toHaveBeenCalledWith("domovoi:clipboard-write", expect.anything())
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
