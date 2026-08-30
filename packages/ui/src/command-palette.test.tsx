import { describe, expect, it, vi } from "vitest"

import {
  buildWorkspaceCommands,
  commandPaletteShortcut,
  rankWorkspaceCommands,
  restoreCommandPaletteFocus,
  type WorkspaceCommand,
} from "./command-palette"

describe("commandPaletteShortcut", () => {
  it("uses Command+K on macOS and Ctrl+K on Windows and Linux", () => {
    expect(commandPaletteShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false }, "darwin")).toBe(true)
    expect(commandPaletteShortcut({ key: "K", metaKey: false, ctrlKey: true, altKey: false }, "linux")).toBe(true)
    expect(commandPaletteShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: false }, "win32")).toBe(true)
    expect(commandPaletteShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: false }, "darwin")).toBe(false)
    expect(commandPaletteShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false }, "linux")).toBe(false)
    expect(commandPaletteShortcut({ key: "k", metaKey: true, ctrlKey: true, altKey: false }, "win32")).toBe(false)
    expect(commandPaletteShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: true }, "linux")).toBe(false)
    expect(commandPaletteShortcut({ key: "p", metaKey: false, ctrlKey: true, altKey: false }, "linux")).toBe(false)
  })
})

describe("rankWorkspaceCommands", () => {
  const commands = [
    { id: "new-session", label: "New session", section: "Session", keywords: ["create", "agent"], run: vi.fn() },
    { id: "open-project", label: "Open project", section: "Project", keywords: ["folder", "repository"], run: vi.fn() },
    { id: "providers", label: "Provider settings", section: "Navigate", keywords: ["models", "credentials"], run: vi.fn() },
  ] satisfies WorkspaceCommand[]

  it("filters by label and keywords with exact-prefix ranking", () => {
    expect(rankWorkspaceCommands(commands, "project").map(({ id }) => id)).toEqual(["open-project"])
    expect(rankWorkspaceCommands(commands, "cre").map(({ id }) => id)).toEqual(["new-session", "providers"])
    expect(rankWorkspaceCommands(commands, "provider").map(({ id }) => id)).toEqual(["providers"])
  })

  it("keeps source order for an empty query", () => {
    expect(rankWorkspaceCommands(commands, "  ").map(({ id }) => id)).toEqual([
      "new-session",
      "open-project",
      "providers",
    ])
  })
})

describe("buildWorkspaceCommands", () => {
  it("exposes only current safe actions and respects connection state", () => {
    const callbacks = {
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    }
    const connected = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      ...callbacks,
    })
    expect(connected.map(({ id }) => id)).toEqual([
      "open-project",
      "new-session",
      "pause-all",
      "surface-workspace",
      "surface-providers",
      "surface-skills",
      "surface-audit",
    ])
    expect(connected.find(({ id }) => id === "reconnect")).toBeUndefined()

    const disconnected = buildWorkspaceCommands({
      connected: false,
      emergencyStopPending: false,
      hasProject: false,
      ...callbacks,
    })
    expect(disconnected.map(({ id }) => id)).toContain("reconnect")
    expect(disconnected.find(({ id }) => id === "pause-all")?.disabled).toBe(true)
    expect(disconnected.find(({ id }) => id === "new-session")?.disabled).toBe(true)
  })

  it("routes surface and session commands through supplied actions", () => {
    const callbacks = {
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    }
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      ...callbacks,
    })
    commands.find(({ id }) => id === "new-session")?.run()
    commands.find(({ id }) => id === "surface-skills")?.run()
    expect(callbacks.newSession).toHaveBeenCalledOnce()
    expect(callbacks.setSurface).toHaveBeenCalledWith("skills")
  })

  it("adds desktop worktree actions only when an active path is available", () => {
    const openInEditor = vi.fn()
    const copyWorktreePath = vi.fn()
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      activeWorkspacePath: "/worktrees/session-one",
      openInEditor,
      copyWorktreePath,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    })

    expect(commands.map(({ id }) => id)).toContain("open-in-editor")
    expect(commands.map(({ id }) => id)).toContain("copy-worktree-path")
    commands.find(({ id }) => id === "open-in-editor")?.run()
    commands.find(({ id }) => id === "copy-worktree-path")?.run()
    expect(openInEditor).toHaveBeenCalledOnce()
    expect(copyWorktreePath).toHaveBeenCalledOnce()
  })
})

it("restores focus to the element active before the palette opened", () => {
  const focus = vi.fn()
  restoreCommandPaletteFocus({ focus })
  expect(focus).toHaveBeenCalledOnce()
  expect(() => restoreCommandPaletteFocus(null)).not.toThrow()
})
