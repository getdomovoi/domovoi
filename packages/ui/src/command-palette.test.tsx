import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import {
  buildWorkspaceCommands,
  opensElsewhere,
  sessionTone,
  commandPaletteShortcut,
  rankWorkspaceCommands,
  restoreCommandPaletteFocus,
  type WorkspaceCommand,
} from "./command-palette"
import { openDesktopPath, type DesktopWindowBridge } from "./desktop-platform"

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
    emergencyStop: vi.fn(),
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
      "emergency-stop",
      "surface-workspace",
      "surface-providers",
      "surface-skills",
      "surface-fleet",
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
    expect(disconnected.find(({ id }) => id === "emergency-stop")?.disabled).toBe(true)
    expect(disconnected.find(({ id }) => id === "pause-all")?.disabled).toBe(true)
    expect(disconnected.find(({ id }) => id === "new-session")?.disabled).toBe(true)
  })

  it("offers Take a checkpoint for the active session and locks it while a turn runs", () => {
    const takeCheckpoint = vi.fn()
    const base = {
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
      emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    }
    const idle = buildWorkspaceCommands({ ...base, takeCheckpoint, checkpointBlocked: false })
    const command = idle.find(({ id }) => id === "take-checkpoint")
    expect(command).toMatchObject({ label: "Take a checkpoint", section: "Session", disabled: false })
    command?.run()
    expect(takeCheckpoint).toHaveBeenCalledOnce()

    const running = buildWorkspaceCommands({ ...base, takeCheckpoint, checkpointBlocked: true })
    expect(running.find(({ id }) => id === "take-checkpoint")?.disabled).toBe(true)
    expect(buildWorkspaceCommands(base).find(({ id }) => id === "take-checkpoint")).toBeUndefined()
  })

  it("routes surface and session commands through supplied actions", () => {
    const callbacks = {
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
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
    commands.find(({ id }) => id === "surface-fleet")?.run()
    expect(callbacks.newSession).toHaveBeenCalledOnce()
    expect(callbacks.setSurface).toHaveBeenCalledWith("skills")
    expect(callbacks.setSurface).toHaveBeenCalledWith("fleet")
  })

  it("adds desktop worktree actions only when an active path is available", () => {
    const openExternal = vi.fn(async () => true)
    const desktopBridge = { openExternal } as unknown as DesktopWindowBridge
    const openInEditor = vi.fn(() => openDesktopPath(
      desktopBridge,
      "/worktrees/session-one",
      "cursor",
    ))
    const copyWorktreePath = vi.fn()
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      activeWorkspacePath: "/worktrees/session-one",
      openInEditor,
      externalEditor: "cursor",
      copyWorktreePath,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    })

    expect(commands.map(({ id }) => id)).toContain("open-in-editor")
    expect(commands.map(({ id }) => id)).toContain("copy-worktree-path")
    expect(commands.find(({ id }) => id === "open-in-editor")?.label).toBe("Open in Cursor")
    commands.find(({ id }) => id === "open-in-editor")?.run()
    commands.find(({ id }) => id === "copy-worktree-path")?.run()
    expect(openInEditor).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith({
      editor: "cursor",
      path: "/worktrees/session-one",
    })
    expect(copyWorktreePath).toHaveBeenCalledOnce()
  })

  it("labels a system handoff as Open externally", () => {
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      activeWorkspacePath: "/worktrees/session-one",
      openInEditor: vi.fn(),
      externalEditor: "system",
      copyWorktreePath: vi.fn(),
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    })

    expect(commands.find(({ id }) => id === "open-in-editor")?.label).toBe("Open externally")
  })
})

it("restores focus to the element active before the palette opened", () => {
  const focus = vi.fn()
  restoreCommandPaletteFocus({ focus })
  expect(focus).toHaveBeenCalledOnce()
  expect(() => restoreCommandPaletteFocus(null)).not.toThrow()
})

describe("launcher entities", () => {
  // The design lists things, not only verbs: a dot for state, a machine-readable
  // line beneath the name, and the kind it is. A verb carries none of those, and
  // detail stays on the entity because launcher-entries.test.ts pins it.
  it("gives an entity its kind and meta, and a verb neither", () => {
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
      skills: [{ id: "design-studio", name: "design-studio", scope: "built-in" }],
      openSkill: vi.fn(),
    })
    const found = (id: string) => commands.find((command) => command.id === id)!

    expect(found("skill-design-studio").kind).toBe("SKILL")
    expect(found("skill-design-studio").meta).toBe("built-in skill")
    expect(found("skill-design-studio").detail).toBe("built-in")

    expect(found("open-project").kind).toBeUndefined()
    expect(found("open-project").meta).toBeUndefined()
  })

  it("reads a session's tone from its state rather than leaving it to colour", () => {
    expect(sessionTone("failed")).toBe("offline")
    expect(sessionTone("waiting")).toBe("waiting")
    expect(sessionTone("transferred")).toBe("idle")
    expect(sessionTone("active")).toBe("online")
    expect(sessionTone("idle")).toBe("idle")
  })
})

describe("open elsewhere", () => {
  it("reads the platform's own modifier, matching the toggle", () => {
    expect(opensElsewhere({ key: "Enter", metaKey: true, ctrlKey: false }, "darwin")).toBe(true)
    expect(opensElsewhere({ key: "Enter", metaKey: false, ctrlKey: true }, "darwin")).toBe(false)
    expect(opensElsewhere({ key: "Enter", metaKey: false, ctrlKey: true }, "linux")).toBe(true)
    expect(opensElsewhere({ key: "Enter", metaKey: true, ctrlKey: false }, "linux")).toBe(false)
    expect(opensElsewhere({ key: "Enter", metaKey: false, ctrlKey: false }, "darwin")).toBe(false)
    expect(opensElsewhere({ key: "k", metaKey: true, ctrlKey: false }, "darwin")).toBe(false)
  })

  // A move is never performed from the launcher. It opens the preflight and the
  // existing consent surface takes the decision.
  it("offers a live session a move and a machine a start, and a verb neither", () => {
    const session = structuredClone(demoWorkspace).sessions[0]!
    const previewTransferTo = vi.fn()
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
      sessions: [session],
      activateSession: vi.fn(),
      previewTransferTo,
      currentMachineId: "machine-here",
      entries: [],
    })
    const found = (id: string) => commands.find((command) => command.id === id)!

    // A live session carries a choice, not an action: it has to be told which
    // machine before anything can move.
    expect(found(`session-${session.id}`).elsewhereTargets).toEqual([])
    expect(found(`session-${session.id}`).openElsewhere).toBeUndefined()
    expect(found("open-project").elsewhereTargets).toBeUndefined()
    expect(found("new-session").elsewhereTargets).toBeUndefined()
  })

  it("says nothing about elsewhere when the shell offers no way to get there", () => {
    const session = structuredClone(demoWorkspace).sessions[0]!
    const commands = buildWorkspaceCommands({
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
    emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
      sessions: [session],
      activateSession: vi.fn(),
    })
    expect(commands.find((command) => command.id === `session-${session.id}`)?.elsewhereTargets).toBeUndefined()
  })
})

