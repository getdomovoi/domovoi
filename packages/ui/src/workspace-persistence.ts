import { isDesktopExternalEditor, type DesktopExternalEditor } from "./desktop-platform"

export const workspaceUiStorageKey = "domovoi.workspace-ui"

export type WorkspaceSurface = "workspace" | "providers" | "skills" | "audit"

const surfaces = new Set<WorkspaceSurface>(["workspace", "providers", "skills", "audit"])
const layoutKeys = new Set(["sidebar.dock", "sidebar.rail", "rail.dock", "rail.rail"])
const panelIds = new Set(["sessions", "thread", "dock"])

export type WorkspaceUiState = {
  version: 2
  sidebarCollapsed: boolean
  dockCollapsed: boolean
  surface: WorkspaceSurface
  projectId: string | null
  sessionId: string | null
  externalEditor: DesktopExternalEditor
  layouts: Record<string, Record<string, number>>
}

export type WorkspaceUiDaemonTruth = {
  projectId: string | null
  activeSessionId: string | null
  sessionIds: readonly string[]
}

export function defaultWorkspaceUiState(): WorkspaceUiState {
  return {
    version: 2,
    sidebarCollapsed: false,
    dockCollapsed: false,
    surface: "workspace",
    projectId: null,
    sessionId: null,
    externalEditor: "system",
    layouts: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function parseLayouts(value: unknown): WorkspaceUiState["layouts"] | undefined {
  if (!isRecord(value)) return undefined
  const parsed: WorkspaceUiState["layouts"] = {}
  for (const [layoutKey, layout] of Object.entries(value)) {
    if (!layoutKeys.has(layoutKey) || !isRecord(layout)) return undefined
    const panels: Record<string, number> = {}
    const entries = Object.entries(layout)
    if (entries.length === 0) return undefined
    for (const [panelId, size] of entries) {
      if (
        !panelIds.has(panelId)
        || typeof size !== "number"
        || !Number.isFinite(size)
        || size <= 0
        || size > 100
      ) return undefined
      panels[panelId] = size
    }
    parsed[layoutKey] = panels
  }
  return parsed
}

export function parseWorkspaceUiState(value: unknown): WorkspaceUiState | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return undefined
  if (typeof value.sidebarCollapsed !== "boolean" || typeof value.dockCollapsed !== "boolean") {
    return undefined
  }
  if (typeof value.surface !== "string" || !surfaces.has(value.surface as WorkspaceSurface)) {
    return undefined
  }
  if (!isId(value.projectId) || !isId(value.sessionId)) return undefined
  const layouts = parseLayouts(value.layouts)
  if (!layouts) return undefined
  return {
    version: 2,
    sidebarCollapsed: value.sidebarCollapsed,
    dockCollapsed: value.dockCollapsed,
    surface: value.surface as WorkspaceSurface,
    projectId: value.projectId,
    sessionId: value.sessionId,
    externalEditor: value.version === 2 && isDesktopExternalEditor(value.externalEditor)
      ? value.externalEditor
      : "system",
    layouts,
  }
}

export function browserWorkspaceUiStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function loadWorkspaceUiState(storage?: Pick<Storage, "getItem">): WorkspaceUiState {
  if (!storage) return defaultWorkspaceUiState()
  try {
    const raw = storage.getItem(workspaceUiStorageKey)
    if (!raw) return defaultWorkspaceUiState()
    return parseWorkspaceUiState(JSON.parse(raw)) ?? defaultWorkspaceUiState()
  } catch {
    return defaultWorkspaceUiState()
  }
}

export function saveWorkspaceUiState(
  storage: Pick<Storage, "setItem"> | undefined,
  state: WorkspaceUiState,
): void {
  if (!storage) return
  const safe = parseWorkspaceUiState(state)
  if (!safe) return
  try {
    storage.setItem(workspaceUiStorageKey, JSON.stringify(safe))
  } catch {
    // Private browsing, policy controls, and full storage must not break the workspace.
  }
}

export function reconcileWorkspaceUiState(
  state: WorkspaceUiState,
  truth: WorkspaceUiDaemonTruth,
): WorkspaceUiState {
  const projectChanged = state.projectId !== truth.projectId
  const activeSessionId = truth.activeSessionId !== null
    && truth.sessionIds.includes(truth.activeSessionId)
    ? truth.activeSessionId
    : null
  const next: WorkspaceUiState = {
    ...state,
    surface: projectChanged ? "workspace" : state.surface,
    projectId: truth.projectId,
    sessionId: activeSessionId,
  }
  return next.surface === state.surface
    && next.projectId === state.projectId
    && next.sessionId === state.sessionId
    ? state
    : next
}
