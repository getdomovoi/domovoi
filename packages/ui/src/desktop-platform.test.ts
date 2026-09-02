import { describe, expect, it, vi } from "vitest"

import {
  copyDesktopText,
  desktopExternalActionLabel,
  enqueueDesktopDeepLink,
  openDesktopPath,
  openProjectFromDesktop,
  type DesktopWindowBridge,
} from "./desktop-platform"

function bridge(overrides: Partial<DesktopWindowBridge> = {}): DesktopWindowBridge {
  return {
    platform: "linux",
    getRpcToken: vi.fn(async () => "token"),
    captureAnnotation: vi.fn(),
    notify: vi.fn(async () => true),
    onNotificationActivate: vi.fn(() => vi.fn()),
    openDirectory: vi.fn(async () => ({ status: "cancelled" as const })),
    readClipboardText: vi.fn(async () => "clipboard"),
    writeClipboardText: vi.fn(async () => true),
    openExternal: vi.fn(async () => true),
    onDeepLink: vi.fn(() => vi.fn()),
    getWindowDecoration: vi.fn(async () => "domovoi" as const),
    setWindowDecoration: vi.fn(async () => true),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

describe("openProjectFromDesktop", () => {
  it("does nothing after native dialog cancellation", async () => {
    const openProject = vi.fn()
    await expect(openProjectFromDesktop(bridge(), openProject)).resolves.toBe("cancelled")
    expect(openProject).not.toHaveBeenCalled()
  })

  it("opens only the validated path returned by the desktop", async () => {
    const openProject = vi.fn(async () => {})
    await expect(openProjectFromDesktop(bridge({
      openDirectory: vi.fn(async () => ({ status: "selected" as const, path: "/home/dev/project" })),
    }), openProject)).resolves.toBe("opened")
    expect(openProject).toHaveBeenCalledWith("/home/dev/project")
  })
})

describe("enqueueDesktopDeepLink", () => {
  it("deduplicates valid IDs and bounds links that arrive before daemon readiness", () => {
    expect(enqueueDesktopDeepLink(["session-one"], "session-one")).toEqual(["session-one"])
    expect(enqueueDesktopDeepLink(["session-one"], "../private")).toEqual(["session-one"])
    const full = Array.from({ length: 32 }, (_, index) => `session-${index}`)
    expect(enqueueDesktopDeepLink(full, "session-latest")).toEqual([
      ...full.slice(1),
      "session-latest",
    ])
  })
})

describe("desktop clipboard and editor actions", () => {
  it("never describes the system file association as an editor", () => {
    expect(desktopExternalActionLabel("system")).toBe("Open externally")
    expect(desktopExternalActionLabel("system")).not.toContain("editor")
    expect(desktopExternalActionLabel("vscode")).toBe("Open in VS Code")
    expect(desktopExternalActionLabel("cursor")).toBe("Open in Cursor")
    expect(desktopExternalActionLabel("zed")).toBe("Open in Zed")
  })

  it("copies bounded text and opens an allowlisted system target", async () => {
    const target = bridge()
    await expect(copyDesktopText(target, "/worktrees/session-one")).resolves.toBeUndefined()
    await expect(openDesktopPath(target, "/worktrees/session-one", "system")).resolves.toBeUndefined()
    expect(target.writeClipboardText).toHaveBeenCalledWith("/worktrees/session-one")
    expect(target.openExternal).toHaveBeenCalledWith({
      editor: "system",
      path: "/worktrees/session-one",
    })
  })

  it.each(["vscode", "cursor", "zed"] as const)(
    "routes a validated %s preference to the isolated desktop bridge",
    async (editor) => {
      const target = bridge()

      await expect(openDesktopPath(target, "/worktrees/session-one", editor)).resolves.toBeUndefined()

      expect(target.openExternal).toHaveBeenCalledWith({
        editor,
        path: "/worktrees/session-one",
      })
    },
  )

  it("turns denied platform results into actionable fixed failures", async () => {
    await expect(copyDesktopText(bridge({
      writeClipboardText: vi.fn(async () => false),
    }), "text")).rejects.toThrow("Clipboard text could not be copied")
    await expect(openDesktopPath(bridge({
      openExternal: vi.fn(async () => false),
    }), "/worktrees/session-one", "cursor")).rejects.toThrow("External editor could not open the worktree")
  })
})
