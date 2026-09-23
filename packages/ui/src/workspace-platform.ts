import type { DesktopNotificationRequest } from "./desktop-notifications.js"

// The narrow host port a browser client can answer. The desktop answers the
// same questions through its preload bridge, so a client supplies one or the
// other and the shell never assumes a capability it was not given. Every
// surface that a host cannot honour reports a refusal with copy the shell can
// show, because a control that quietly does nothing is worse than an absent one.
export type WorkspaceNotificationDelivery =
  | { status: "ready" }
  | { status: "askable" }
  | { status: "refused"; message: string }

export type WorkspaceInstallState =
  | { status: "installed" }
  | { status: "installable" }
  | { status: "manual"; message: string }

export type WorkspaceDirectoryChoice =
  | { status: "selected"; path: string }
  | { status: "refused"; message: string }

export type WorkspacePlatform = {
  dialogs: {
    pickProjectDirectory(): Promise<WorkspaceDirectoryChoice>
  }
  notifications: {
    delivery(): WorkspaceNotificationDelivery
    request(): Promise<WorkspaceNotificationDelivery>
    notify(request: DesktopNotificationRequest): Promise<void>
  }
  clipboard: {
    writeText(value: string): Promise<void>
  }
  install: {
    state(): WorkspaceInstallState
    prompt(): Promise<WorkspaceInstallState>
  }
  // How the client gets new code when a surface's chunk failed to load. A
  // browser answers with a page reload; absent, Try again loads the chunk again.
  code?: {
    reloadForNewCode(): void
  } | undefined
}

export type WorkspaceClientCapabilities = {
  delivery: WorkspaceNotificationDelivery
  install: WorkspaceInstallState
  onRequestDelivery: () => void
  onInstall: () => void
}
