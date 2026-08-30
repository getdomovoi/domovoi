import { describe, expect, it, vi } from "vitest"

import {
  chooseDirectory,
  editorUrlFor,
  ExternalTargetController,
  isBoundedAbsolutePath,
  SafeClipboard,
  type DesktopFileSystem,
} from "./desktop-platform.js"

function fileSystem(entries: Record<string, { real?: string; directory?: boolean }>): DesktopFileSystem {
  return {
    realpath: vi.fn(async (path) => {
      const entry = entries[path]
      if (!entry) throw new Error(`missing ${path}`)
      return entry.real ?? path
    }),
    stat: vi.fn(async (path) => {
      const entry = entries[path]
      if (!entry) throw new Error(`missing ${path}`)
      return {
        isDirectory: () => entry.directory !== false,
        isFile: () => entry.directory === false,
      }
    }),
  }
}

describe("chooseDirectory", () => {
  it("treats native cancellation as a no-op without touching the filesystem", async () => {
    const fs = fileSystem({})
    await expect(chooseDirectory(
      { showOpenDirectory: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
      fs,
      "linux",
    )).resolves.toEqual({ status: "cancelled" })
    expect(fs.realpath).not.toHaveBeenCalled()
  })

  it("returns one canonical readable directory", async () => {
    const fs = fileSystem({
      "/home/dev/link": { real: "/home/dev/project" },
      "/home/dev/project": { directory: true },
    })
    await expect(chooseDirectory(
      { showOpenDirectory: vi.fn(async () => ({ canceled: false, filePaths: ["/home/dev/link"] })) },
      fs,
      "linux",
    )).resolves.toEqual({ status: "selected", path: "/home/dev/project" })
  })

  it("rejects malformed, relative, and non-directory selections with fixed secret-free errors", async () => {
    const fs = fileSystem({ "/home/dev/secret.txt": { directory: false } })
    for (const filePaths of [[], ["relative/private"], ["/one", "/two"], ["/home/dev/secret.txt"]]) {
      const result = chooseDirectory(
        { showOpenDirectory: vi.fn(async () => ({ canceled: false, filePaths })) },
        fs,
        "linux",
      )
      await expect(result).rejects.toThrow("Domovoi could not use the selected folder")
      await result.catch((cause: unknown) => {
        expect(String(cause)).not.toContain("secret.txt")
        expect(String(cause)).not.toContain("relative/private")
      })
    }
  })
})

describe("isBoundedAbsolutePath", () => {
  it("recognizes native absolute paths on Linux, macOS, and Windows", () => {
    expect(isBoundedAbsolutePath("/home/dev/project", "linux")).toBe(true)
    expect(isBoundedAbsolutePath("/Users/dev/project", "darwin")).toBe(true)
    expect(isBoundedAbsolutePath("C:\\Users\\dev\\project", "win32")).toBe(true)
    expect(isBoundedAbsolutePath("\\\\server\\share\\project", "win32")).toBe(true)
    expect(isBoundedAbsolutePath("C:relative", "win32")).toBe(false)
    expect(isBoundedAbsolutePath("relative/project", "linux")).toBe(false)
    expect(isBoundedAbsolutePath(`/tmp/${"a".repeat(4_096)}`, "linux")).toBe(false)
    expect(isBoundedAbsolutePath("/tmp/project\0secret", "linux")).toBe(false)
  })
})

describe("SafeClipboard", () => {
  it("reads and writes bounded plain text without exposing the adapter", async () => {
    const adapter = {
      readText: vi.fn(() => "copied text"),
      writeText: vi.fn(),
    }
    const clipboard = new SafeClipboard(adapter)
    await expect(clipboard.readText()).resolves.toBe("copied text")
    await expect(clipboard.writeText("new text")).resolves.toBe(true)
    expect(adapter.writeText).toHaveBeenCalledWith("new text")
    expect(clipboard).not.toHaveProperty("adapter")
  })

  it("rejects non-text and oversized clipboard contents with fixed errors", async () => {
    const adapter = {
      readText: vi.fn(() => "x".repeat(1_000_001)),
      writeText: vi.fn(),
    }
    const clipboard = new SafeClipboard(adapter)
    await expect(clipboard.readText()).rejects.toThrow("Clipboard text is too large")
    await expect(clipboard.writeText({ token: "secret" })).rejects.toThrow("Clipboard text is invalid")
    await expect(clipboard.writeText("x".repeat(1_000_001))).rejects.toThrow("Clipboard text is too large")
    expect(adapter.writeText).not.toHaveBeenCalled()
  })
})

describe("ExternalTargetController", () => {
  it("opens allowlisted paths through Electron without shell interpolation", async () => {
    const shell = { openPath: vi.fn(async () => ""), openExternal: vi.fn(async (_url: string) => {}) }
    const controller = new ExternalTargetController(shell, fileSystem({
      "/home/dev/.domovoi/worktrees": { directory: true },
      "/home/dev/.domovoi/worktrees/session-one": { directory: true },
    }), { platform: "linux", allowedRoots: ["/home/dev/.domovoi/worktrees"] })

    await expect(controller.open({ editor: "system", path: "/home/dev/.domovoi/worktrees/session-one" })).resolves.toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith("/home/dev/.domovoi/worktrees/session-one")
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it("uses only allowlisted editor schemes and percent-encoded file URLs", async () => {
    const shell = { openPath: vi.fn(async () => ""), openExternal: vi.fn(async (_url: string) => {}) }
    const controller = new ExternalTargetController(shell, fileSystem({
      "/home/dev/project": { directory: true },
      "/home/dev/project/file name;$(touch hacked).ts": { directory: false },
    }), { platform: "linux", allowedRoots: ["/home/dev/project"] })

    await expect(controller.open({
      editor: "vscode",
      path: "/home/dev/project/file name;$(touch hacked).ts",
    })).resolves.toBe(true)
    const url = shell.openExternal.mock.calls[0]?.[0]
    expect(url).toMatch(/^vscode:\/\/file\/home\/dev\/project\//)
    expect(url).toContain("file%20name;%24%28touch%20hacked%29.ts")
    expect(shell.openPath).not.toHaveBeenCalled()

    for (const editor of ["https", "file", "javascript", "unknown"]) {
      await expect(controller.open({ editor, path: "/home/dev/project" })).rejects.toThrow(
        "External editor request is invalid",
      )
    }
  })

  it("rejects paths outside allowed roots and replaces native errors", async () => {
    const shell = {
      openPath: vi.fn(async () => "native failure at /private/token.txt"),
      openExternal: vi.fn(async () => { throw new Error("launch token=secret") }),
    }
    const fs = fileSystem({
      "/home/dev/project": { directory: true },
      "/home/dev/project/file.ts": { directory: false },
      "/private/token.txt": { directory: false },
    })
    const controller = new ExternalTargetController(shell, fs, {
      platform: "linux",
      allowedRoots: ["/home/dev/project"],
    })

    await expect(controller.open({ editor: "system", path: "/private/token.txt" })).rejects.toThrow(
      "External editor request is not allowed",
    )
    await expect(controller.open({ editor: "system", path: "/home/dev/project/file.ts" })).rejects.toThrow(
      "External editor could not open the item",
    )
    await expect(controller.open({ editor: "zed", path: "/home/dev/project/file.ts" })).rejects.toThrow(
      "External editor could not open the item",
    )
    for (const outcome of await Promise.allSettled([
      controller.open({ editor: "system", path: "/home/dev/project/file.ts" }),
      controller.open({ editor: "zed", path: "/home/dev/project/file.ts" }),
    ])) {
      expect(outcome.status).toBe("rejected")
      if (outcome.status !== "rejected") throw new Error("Expected external editor failure")
      expect(String(outcome.reason)).not.toContain("token.txt")
      expect(String(outcome.reason)).not.toContain("token=secret")
    }
  })
})

it("builds cross-platform editor URLs without accepting a caller-provided scheme", () => {
  expect(editorUrlFor("cursor", "C:\\Users\\Dev\\project\\file.ts", "win32")).toBe(
    "cursor://file/C:/Users/Dev/project/file.ts",
  )
  expect(editorUrlFor("zed", "/home/dev/project/file.ts", "linux")).toBe(
    "zed://file/home/dev/project/file.ts",
  )
})
