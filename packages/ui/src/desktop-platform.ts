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

// What the main process answers about the login service, as the renderer
// draws it. Plain data: the desktop keeps the paths and errors, the page keeps
// the words.
export type DaemonServiceProfileRecovery = "recorded" | "not-needed" | "operator-confirmation-required" | "proof-unavailable"

// What the main process reports after an install or a removal. A removal
// carries what the daemon's installer said about the profile owner, whether a
// daemon this app reaches is running, and whether it is one the app did not
// start (daemonAttached). A failure carries the service as read back
// afterwards, null when it could not be read.
export type DaemonServiceOutcome =
  | { ok: true; kind: "file" | "task"; target: string; daemonRunning: boolean; daemonAttached?: boolean; profileRecovery?: DaemonServiceProfileRecovery; profileRecoveryDetail?: string }
  | { ok: false; reason: "runtime-missing"; part: "node" | "daemon"; path: string; message: string }
  | { ok: false; reason: "installed-not-attached"; kind: "file" | "task"; target: string; message: string }
  | { ok: false; reason: "busy"; message: string }
  | { ok: false; reason: "refused"; message: string }
  | { ok: false; reason: "check-failed"; message: string }
  | { ok: false; reason: "failed"; message: string; daemon: "untouched" | "restarted" | "attached" | "stopped"; service: { installed: boolean | null; running: boolean } | null }
  // An in-place update that did not end with the new service running; the
  // message is the daemon's own (ruled 2026-09-23).
  | { ok: false; reason: "update-failed"; message: string }

export type DaemonServiceStatusReport =
  | { installed: boolean | null; running: boolean; detail: string }
  | { unavailable: string }

export type DesktopWindowBridge = {
  fleetRoute?(machineId: string, budgetMs: number): Promise<unknown>
  forgetFleetRoute?(machineId: string): Promise<unknown>
  // One machine's relay pin, kept by the main process in a private file. The
  // renderer sees keys and values, never the path.
  readRelayPin?(key: string): Promise<string | undefined>
  swapRelayPin?(key: string, expected: string | undefined, replacement: string): Promise<boolean>
  platform: "darwin" | "linux" | "win32"
  // Pixels from the window's leading edge to where titlebar content may
  // start, past the OS-drawn window buttons; 0 where there are none.
  titlebarLeadingInset?: number | undefined
  getRpcEndpoint(): Promise<{ url: string; token: string }>
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
  // J24: the login service, on desktops that ship a daemon runtime.
  daemonService?: {
    status(): Promise<DaemonServiceStatusReport>
    install(): Promise<DaemonServiceOutcome>
    remove(): Promise<DaemonServiceOutcome>
    // Ruled 2026-09-23 (#577, B): moves the running service to this app's
    // runtime in place.
    update(): Promise<DaemonServiceOutcome>
  }
  // One fixed address, the release page, opened in the person's browser. The
  // renderer names no URL, so this cannot become a way to open any address.
  openReleasePage?(): Promise<boolean>
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
