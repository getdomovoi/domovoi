import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import { restoreCommandPaletteFocus } from "./command-palette"
import {
  buildWorkspaceCommands,
  opensElsewhere,
  sessionTone,
  commandPaletteShortcut,
  rankWorkspaceCommands,
  shortcutLabel,
  workspaceShortcut,
  type WorkspaceCommand,
} from "./workspace-commands"
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
    // Ruling Q376 A (2026-10-02): the design's commands lead, and the ones it
    // does not draw follow them.
    expect(connected.map(({ id }) => id)).toEqual([
      "surface-fleet",
      "surface-audit",
      "open-project",
      "new-session",
      "pause-all",
      "emergency-stop",
      "surface-workspace",
      "surface-providers",
      "surface-skills",
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

// Desktop V2's palette (paletteGroups, COMMANDS): the session commands it
// draws, with its labels and meta. Ruling Q288 A (2026-10-01) leaves out
// "Run a migration on this machine" and "Open a pull request".
describe("v2 session commands", () => {
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
  const designIds = [
    "open-changes",
    "take-checkpoint",
    "revert-checkpoint",
    "review-rules",
    "move-session",
    "surface-fleet",
    "pair-device",
    "surface-audit",
  ]
  const openers = () => ({
    openChanges: vi.fn(),
    takeCheckpoint: vi.fn(),
    checkpointBlocked: false,
    revertToCheckpoint: vi.fn(),
    reviewRules: vi.fn(),
    approvalRuleCount: 4,
    moveSession: vi.fn(),
    pairDevice: vi.fn(),
    shortcutsBound: true,
  })

  it("lists the design's commands in its order, with its labels and meta", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers() })
    expect(commands
      .filter(({ id }) => designIds.includes(id))
      .map(({ id, label, detail, shortcut }) => ({ id, label, detail, shortcut })))
      .toEqual([
        { id: "open-changes", label: "Open the changes sheet", detail: undefined, shortcut: "mod+shift+D" },
        { id: "take-checkpoint", label: "Take a checkpoint", detail: "manual", shortcut: undefined },
        { id: "revert-checkpoint", label: "Revert to a checkpoint", detail: undefined, shortcut: undefined },
        { id: "review-rules", label: "Review what you have allowed", detail: "4 rules", shortcut: undefined },
        { id: "move-session", label: "Move this session to another machine", detail: "handoff", shortcut: undefined },
        { id: "surface-fleet", label: "Show all machines", detail: undefined, shortcut: "mod+shift+M" },
        { id: "pair-device", label: "Pair a phone or tablet", detail: "settings", shortcut: undefined },
        { id: "surface-audit", label: "Read the audit log", detail: "on this machine", shortcut: undefined },
      ])
  })

  // Ruling Q376 A (2026-10-02): the undrawn commands stay, after the design's.
  it("puts the design's commands ahead of the ones it does not draw", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers(), openCheckpoints: vi.fn() })
    const verbs = commands.filter((command) => !command.kind).map(({ id }) => id)
    expect(verbs.slice(0, designIds.length)).toEqual(designIds)
    expect(verbs.slice(designIds.length)).toEqual([
      "open-project",
      "new-session",
      "pause-all",
      "emergency-stop",
      "surface-workspace",
      "surface-providers",
      "surface-skills",
      "open-checkpoints",
    ])
  })

  // Ruling Q375 A (2026-10-02): every row is marked with a coloured dot, and a
  // drawn command takes the colour the design gives it.
  it("gives each command the design's dot colour, and every other command one", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers(), openCheckpoints: vi.fn(), connected: false })
    const tone = (id: string) => commands.find((command) => command.id === id)?.tone
    expect(designIds.map((id) => [id, tone(id)])).toEqual([
      ["open-changes", "handoff"],
      ["take-checkpoint", "online"],
      ["revert-checkpoint", "waiting"],
      ["review-rules", "handoff"],
      ["move-session", "handoff"],
      ["surface-fleet", "online"],
      ["pair-device", "handoff"],
      ["surface-audit", "online"],
    ])
    expect(commands.filter((command) => command.tone === undefined).map(({ id }) => id)).toEqual([])
  })

  it("runs each command through the opener the shell supplies", () => {
    const supplied = openers()
    const setSurface = vi.fn()
    const commands = buildWorkspaceCommands({ ...base, ...supplied, setSurface })
    for (const id of designIds) commands.find((command) => command.id === id)?.run()
    expect(supplied.openChanges).toHaveBeenCalledOnce()
    expect(supplied.takeCheckpoint).toHaveBeenCalledOnce()
    expect(supplied.revertToCheckpoint).toHaveBeenCalledOnce()
    expect(supplied.reviewRules).toHaveBeenCalledOnce()
    expect(supplied.moveSession).toHaveBeenCalledOnce()
    expect(supplied.pairDevice).toHaveBeenCalledOnce()
    expect(setSurface.mock.calls).toEqual([["fleet"], ["audit"]])
  })

  // Ruling Q291 A (2026-10-01): only the desktop binds the two shortcuts, so
  // a shell that does not bind them gets the commands without the meta.
  it("names no shortcut the shell does not bind", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers(), shortcutsBound: false })
    for (const id of ["open-changes", "surface-fleet"]) {
      const command = commands.find((entry) => entry.id === id)
      expect(command).toBeDefined()
      expect(command?.shortcut).toBeUndefined()
    }
    expect(buildWorkspaceCommands(base).find(({ id }) => id === "surface-fleet")?.shortcut).toBeUndefined()
  })

  it("counts one rule in the singular", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers(), approvalRuleCount: 1 })
    expect(commands.find(({ id }) => id === "review-rules")?.detail).toBe("1 rule")
  })

  it("offers no session command the shell cannot run, and neither ruled-out command", () => {
    const ids = buildWorkspaceCommands(base).map(({ id }) => id)
    for (const id of ["open-changes", "revert-checkpoint", "review-rules", "move-session", "pair-device"]) {
      expect(ids).not.toContain(id)
    }
    const labels = buildWorkspaceCommands({ ...base, ...openers() }).map(({ label }) => label)
    expect(labels).not.toContain("Run a migration on this machine")
    expect(labels).not.toContain("Open a pull request")
  })

  it("locks the commands that need the daemon while it is not answering", () => {
    const commands = buildWorkspaceCommands({ ...base, ...openers(), connected: false })
    const disabled = (id: string) => commands.find((command) => command.id === id)?.disabled ?? false
    expect(disabled("move-session")).toBe(true)
    expect(disabled("pair-device")).toBe(true)
    expect(disabled("open-changes")).toBe(false)
    expect(disabled("revert-checkpoint")).toBe(false)
    expect(disabled("review-rules")).toBe(false)
  })

  it("still finds the machines and audit screens by their old names", () => {
    const commands = buildWorkspaceCommands(base)
    expect(rankWorkspaceCommands(commands, "fleet").map(({ id }) => id)).toContain("surface-fleet")
    expect(rankWorkspaceCommands(commands, "audit").map(({ id }) => id)).toContain("surface-audit")
  })
})

describe("workspace shortcuts", () => {
  it("opens the changes sheet and the machines screen with the platform's modifier and Shift", () => {
    expect(workspaceShortcut({ key: "D", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, "darwin")).toBe("changes")
    expect(workspaceShortcut({ key: "M", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }, "linux")).toBe("machines")
    expect(workspaceShortcut({ key: "m", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }, "win32")).toBe("machines")
    expect(workspaceShortcut({ key: "D", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }, "darwin")).toBeNull()
    expect(workspaceShortcut({ key: "d", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "darwin")).toBeNull()
    expect(workspaceShortcut({ key: "M", metaKey: true, ctrlKey: false, altKey: true, shiftKey: true }, "darwin")).toBeNull()
    expect(workspaceShortcut({ key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, "darwin")).toBeNull()
  })

  it("draws a shortcut the way the design's K() does", () => {
    expect(shortcutLabel("mod+shift+D", "darwin")).toBe("⌘⇧D")
    expect(shortcutLabel("mod+shift+M", "linux")).toBe("Ctrl+Shift+M")
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

