import type { PermissionMode } from "@getdomovoi/protocol"

export const desktopFirstRunStorageKey = "domovoi.desktop-first-run"

export type DesktopFirstRunState =
  | {
      version: 1
      status: "pending"
    }
  | {
      version: 1
      status: "complete"
      providerId: string
      permissionMode: PermissionMode
      auto: false
      completedAt: string
    }

type DesktopFirstRunStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const permissionModes = new Set<PermissionMode>(["ask", "plan", "build"])

export function defaultDesktopFirstRunState(): DesktopFirstRunState {
  return { version: 1, status: "pending" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000")
}

export function parseDesktopFirstRunState(value: unknown): DesktopFirstRunState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (value.status === "pending") {
    return hasExactKeys(value, ["version", "status"])
      ? defaultDesktopFirstRunState()
      : undefined
  }
  if (
    value.status !== "complete"
    || !hasExactKeys(value, [
      "version",
      "status",
      "providerId",
      "permissionMode",
      "auto",
      "completedAt",
    ])
    || typeof value.providerId !== "string"
    || !providerIdPattern.test(value.providerId)
    || typeof value.permissionMode !== "string"
    || !permissionModes.has(value.permissionMode as PermissionMode)
    || value.auto !== false
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
  ) return undefined

  return {
    version: 1,
    status: "complete",
    providerId: value.providerId,
    permissionMode: value.permissionMode as PermissionMode,
    auto: false,
    completedAt: value.completedAt,
  }
}

export function completeDesktopFirstRun({
  providerId,
  permissionMode = "build",
  completedAt = new Date().toISOString(),
}: {
  providerId: string
  permissionMode?: PermissionMode
  completedAt?: string
}): DesktopFirstRunState {
  const completed = parseDesktopFirstRunState({
    version: 1,
    status: "complete",
    providerId,
    permissionMode,
    auto: false,
    completedAt,
  })
  if (!completed) throw new Error("Desktop first-run completion is invalid")
  return completed
}

export function browserDesktopFirstRunStorage(): DesktopFirstRunStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function loadDesktopFirstRunState(
  storage?: Pick<DesktopFirstRunStorage, "getItem">,
): DesktopFirstRunState {
  if (!storage) return defaultDesktopFirstRunState()
  try {
    const raw = storage.getItem(desktopFirstRunStorageKey)
    if (!raw) return defaultDesktopFirstRunState()
    return parseDesktopFirstRunState(JSON.parse(raw)) ?? defaultDesktopFirstRunState()
  } catch {
    return defaultDesktopFirstRunState()
  }
}

export function saveDesktopFirstRunState(
  storage: Pick<DesktopFirstRunStorage, "setItem"> | undefined,
  state: DesktopFirstRunState,
): void {
  if (!storage) return
  const safe = parseDesktopFirstRunState(state)
  if (!safe) return
  try {
    storage.setItem(desktopFirstRunStorageKey, JSON.stringify(safe))
  } catch {
    // Storage policy and capacity must not block the desktop workspace.
  }
}

export function resetDesktopFirstRunState(
  storage: Pick<DesktopFirstRunStorage, "removeItem"> | undefined,
): void {
  if (!storage) return
  try {
    storage.removeItem(desktopFirstRunStorageKey)
  } catch {
    // Reset remains safe when storage is unavailable.
  }
}
