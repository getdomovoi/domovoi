import { describe, expect, it, vi } from "vitest"

import {
  defaultWorkspaceUiState,
  loadWorkspaceUiState,
  parseWorkspaceUiState,
  reconcileWorkspaceUiState,
  saveWorkspaceUiState,
  type WorkspaceUiState,
} from "./workspace-persistence"

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set("domovoi.workspace-ui", initial)
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe("workspace UI persistence", () => {
  it("round-trips only versioned non-secret navigation and layout state", () => {
    const storage = memoryStorage()
    const state = {
      version: 4,
      sidebarCollapsed: true,
      dockCollapsed: false,
      surface: "skills",
      projectId: "project-1",
      sessionId: "session-1",
      externalEditor: "cursor",
      theme: "light",
      windowDecoration: "system",
      notifications: { completion: true, failure: true, approvalNeeded: true },
      layouts: {
        "rail.dock": { thread: 68, dock: 32 },
      },
      rpcToken: "must-not-persist",
      providerApiKey: "must-not-persist",
      editorToken: "also-must-not-persist",
    } as WorkspaceUiState & Record<string, unknown>

    saveWorkspaceUiState(storage, state)

    const raw = storage.getItem("domovoi.workspace-ui")!
    expect(raw).not.toContain("must-not-persist")
    expect(loadWorkspaceUiState(storage)).toEqual({
      version: 4,
      sidebarCollapsed: true,
      dockCollapsed: false,
      surface: "skills",
      projectId: "project-1",
      sessionId: "session-1",
      externalEditor: "cursor",
      theme: "light",
      windowDecoration: "system",
      notifications: { completion: true, failure: true, approvalNeeded: true },
      layouts: {
        "rail.dock": { thread: 68, dock: 32 },
      },
    })
  })

  it.each([
    ["dark", "domovoi"],
    ["light", "system"],
    ["system", "system"],
  ] as const)(
    "restores the %s theme and %s window decoration after restart",
    (theme, windowDecoration) => {
      const storage = memoryStorage()
      saveWorkspaceUiState(storage, { ...defaultWorkspaceUiState(), theme, windowDecoration })

      const loaded = loadWorkspaceUiState(storage)
      expect(loaded.theme).toBe(theme)
      expect(loaded.windowDecoration).toBe(windowDecoration)
    },
  )

  it("defaults appearance to the system theme and Domovoi decoration", () => {
    expect(defaultWorkspaceUiState().theme).toBe("system")
    expect(defaultWorkspaceUiState().windowDecoration).toBe("domovoi")
  })

  it("reconciles unknown appearance values to their defaults", () => {
    const invalid = JSON.stringify({
      ...defaultWorkspaceUiState(),
      theme: "solarized",
      windowDecoration: "gnome",
    })
    expect(loadWorkspaceUiState(memoryStorage(invalid))).toMatchObject({
      theme: "system",
      windowDecoration: "domovoi",
    })
  })

  it.each(["vscode", "cursor", "zed"] as const)(
    "restores the validated %s preference after restart without persisting secrets",
    (externalEditor) => {
      const storage = memoryStorage()
      saveWorkspaceUiState(storage, {
        ...defaultWorkspaceUiState(),
        externalEditor,
        editorToken: "token=secret",
      } as WorkspaceUiState & Record<string, unknown>)

      expect(storage.getItem("domovoi.workspace-ui")).not.toContain("token=secret")
      expect(loadWorkspaceUiState(storage).externalEditor).toBe(externalEditor)
    },
  )

  it("migrates version 1 state and reconciles invalid editor values to system", () => {
    const versionOne = JSON.stringify({
      version: 1,
      sidebarCollapsed: true,
      dockCollapsed: false,
      surface: "skills",
      projectId: "project-1",
      sessionId: "session-1",
      layouts: {},
    })
    expect(loadWorkspaceUiState(memoryStorage(versionOne))).toMatchObject({
      version: 4,
      surface: "skills",
      externalEditor: "system",
      theme: "system",
      windowDecoration: "domovoi",
    })

    const invalidEditor = JSON.stringify({
      ...defaultWorkspaceUiState(),
      surface: "skills",
      externalEditor: "../../token.txt?token=secret",
    })
    expect(loadWorkspaceUiState(memoryStorage(invalidEditor))).toMatchObject({
      surface: "skills",
      externalEditor: "system",
    })
  })

  it.each([
    ["invalid JSON", "{"],
    ["unknown version", JSON.stringify({ ...defaultWorkspaceUiState(), version: 4 })],
    ["unknown surface", JSON.stringify({ ...defaultWorkspaceUiState(), surface: "terminal" })],
    ["invalid identifiers", JSON.stringify({ ...defaultWorkspaceUiState(), projectId: "" })],
    ["invalid layout", JSON.stringify({ ...defaultWorkspaceUiState(), layouts: { "sidebar.dock": { thread: Number.NaN } } })],
  ])("falls back safely for %s", (_label, raw) => {
    expect(loadWorkspaceUiState(memoryStorage(raw))).toEqual(defaultWorkspaceUiState())
  })

  it("restores the fleet surface", () => {
    const raw = JSON.stringify({ ...defaultWorkspaceUiState(), surface: "fleet" })
    expect(loadWorkspaceUiState(memoryStorage(raw)).surface).toBe("fleet")
  })

  it("survives unavailable browser storage", () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException("blocked") }),
      setItem: vi.fn(() => { throw new DOMException("full") }),
    } as unknown as Storage

    expect(loadWorkspaceUiState(storage)).toEqual(defaultWorkspaceUiState())
    expect(() => saveWorkspaceUiState(storage, defaultWorkspaceUiState())).not.toThrow()
  })

  it("accepts daemon project and session truth over stale persisted IDs", () => {
    const persisted: WorkspaceUiState = {
      ...defaultWorkspaceUiState(),
      surface: "audit",
      projectId: "stale-project",
      sessionId: "stale-session",
    }

    expect(reconcileWorkspaceUiState(persisted, {
      projectId: "project-live",
      activeSessionId: "session-live",
      sessionIds: ["session-live", "session-other"],
    })).toMatchObject({
      surface: "workspace",
      projectId: "project-live",
      sessionId: "session-live",
    })
  })

  it("keeps a valid surface while refreshing matching daemon IDs", () => {
    const persisted: WorkspaceUiState = {
      ...defaultWorkspaceUiState(),
      surface: "providers",
      projectId: "project-live",
      sessionId: "session-live",
    }

    expect(reconcileWorkspaceUiState(persisted, {
      projectId: "project-live",
      activeSessionId: "session-live",
      sessionIds: ["session-live"],
    })).toEqual(persisted)
  })

  it("drops a stale selected session without changing a valid project surface", () => {
    const persisted: WorkspaceUiState = {
      ...defaultWorkspaceUiState(),
      surface: "skills",
      projectId: "project-live",
      sessionId: "session-gone",
    }

    expect(reconcileWorkspaceUiState(persisted, {
      projectId: "project-live",
      activeSessionId: null,
      sessionIds: ["session-other"],
    })).toMatchObject({
      surface: "skills",
      projectId: "project-live",
      sessionId: null,
    })
  })
})

it("keeps every notification kind on when upgrading a version 3 state", () => {
  const parsed = parseWorkspaceUiState({
    version: 3,
    sidebarCollapsed: false,
    dockCollapsed: false,
    surface: "workspace",
    projectId: null,
    sessionId: null,
    externalEditor: "system",
    theme: "system",
    windowDecoration: "domovoi",
    layouts: {},
  })

  expect(parsed?.version).toBe(4)
  expect(parsed?.notifications).toEqual({ completion: true, failure: true, approvalNeeded: true })
})

it("round-trips a stored notification preference", () => {
  const parsed = parseWorkspaceUiState({
    ...defaultWorkspaceUiState(),
    notifications: { completion: true, failure: false, approvalNeeded: true },
  })

  expect(parsed?.notifications.failure).toBe(false)
})
