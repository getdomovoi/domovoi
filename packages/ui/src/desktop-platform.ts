import type { DesktopNotificationRequest } from "./desktop-notifications"

export type DesktopDirectoryResult =
  | { status: "cancelled" }
  | { status: "selected"; path: string }

export type DesktopExternalEditor = "system" | "vscode" | "vscode-insiders" | "cursor" | "zed"

const desktopExternalEditors = new Set<DesktopExternalEditor>([
  "system",
  "vscode",
  "vscode-insiders",
  "cursor",
  "zed",
])

export type DesktopOpenExternalRequest = {
  editor: DesktopExternalEditor
  path: string
}

export type WorkspaceWindowDecoration = "domovoi" | "system"

const workspaceWindowDecorations = new Set<WorkspaceWindowDecoration>(["domovoi", "system"])

export function isWorkspaceWindowDecoration(value: unknown): value is WorkspaceWindowDecoration {
  return typeof value === "string"
    && workspaceWindowDecorations.has(value as WorkspaceWindowDecoration)
}

export function workspaceWindowDecorationLabel(decoration: WorkspaceWindowDecoration): string {
  return decoration === "domovoi" ? "Domovoi" : "System"
}

export type DesktopWindowBridge = {
  platform: "darwin" | "linux" | "win32"
  getRpcToken(): Promise<string>
  captureAnnotation(rect: { x: number; y: number; width: number; height: number }): Promise<{
    mimeType: "image/png"
    width: number
    height: number
    data: string
  }>
  notify(request: DesktopNotificationRequest): Promise<boolean>
  onNotificationActivate(listener: (sessionId: string) => void): () => void
  openDirectory(): Promise<DesktopDirectoryResult>
  readClipboardText(): Promise<string>
  writeClipboardText(value: string): Promise<boolean>
  openExternal(request: DesktopOpenExternalRequest): Promise<boolean>
  onDeepLink(listener: (sessionId: string) => void): () => void
  getWindowDecoration(): Promise<WorkspaceWindowDecoration>
  setWindowDecoration(decoration: WorkspaceWindowDecoration): Promise<boolean>
  minimize(): void
  maximize(): void
  close(): void
}

const desktopSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export function enqueueDesktopDeepLink(
  pending: readonly string[],
  sessionId: string,
): string[] {
  if (!desktopSessionIdPattern.test(sessionId) || pending.includes(sessionId)) return [...pending]
  return [...pending.slice(-31), sessionId]
}

export async function openProjectFromDesktop(
  bridge: DesktopWindowBridge,
  openProject: (path: string) => Promise<void>,
): Promise<"cancelled" | "opened"> {
  const result = await bridge.openDirectory()
  if (result.status === "cancelled") return "cancelled"
  await openProject(result.path)
  return "opened"
}

export async function copyDesktopText(bridge: DesktopWindowBridge, value: string): Promise<void> {
  if (!await bridge.writeClipboardText(value)) throw new Error("Clipboard text could not be copied")
}

export function isDesktopExternalEditor(value: unknown): value is DesktopExternalEditor {
  return typeof value === "string" && desktopExternalEditors.has(value as DesktopExternalEditor)
}

export function desktopExternalActionLabel(editor: DesktopExternalEditor): string {
  if (editor === "system") return "Open externally"
  if (editor === "vscode") return "Open in VS Code"
  if (editor === "vscode-insiders") return "Open in VS Code Insiders"
  if (editor === "cursor") return "Open in Cursor"
  return "Open in Zed"
}

export async function openDesktopPath(
  bridge: DesktopWindowBridge,
  path: string,
  editor: DesktopExternalEditor,
): Promise<void> {
  if (!await bridge.openExternal({ editor, path })) {
    throw new Error("External editor could not open the worktree")
  }
}
