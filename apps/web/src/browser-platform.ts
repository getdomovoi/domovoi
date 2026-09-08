import type { DesktopNotificationRequest } from "@/desktop-notifications"
import type {
  WorkspaceDirectoryChoice,
  WorkspaceInstallState,
  WorkspaceNotificationDelivery,
  WorkspacePlatform,
} from "@/workspace-platform"

import {
  BrowserCapabilityError,
  browserRefusalMessage,
  type BrowserRefusalReason,
} from "./platform-refusals"

export type BrowserNotificationPermission = "default" | "denied" | "granted"

export type BrowserNotificationHost = {
  permission(): BrowserNotificationPermission
  request(): Promise<unknown>
  show(options: { title: string; body: string; tag: string }): void
}

export type BrowserClipboardHost = {
  writeText(value: string): Promise<void>
}

export type BrowserInstallHost = {
  homeScreenOnly: boolean
  installed(): boolean
  promptable(): boolean
  prompt(): Promise<void>
}

export type BrowserPlatformEnvironment = {
  secureContext: boolean
  notifications: BrowserNotificationHost | undefined
  clipboard: BrowserClipboardHost | undefined
  install: BrowserInstallHost
}

const notificationCopy: Record<DesktopNotificationRequest["kind"], { title: string; body: string }> = {
  completion: { title: "Domovoi finished", body: "Agent work completed. Open Domovoi to review it." },
  failure: { title: "Domovoi needs attention", body: "Agent work failed. Open Domovoi to review recovery options." },
  "approval-needed": { title: "Approval needed", body: "Agent work is waiting for your decision in Domovoi." },
}

type NotificationState =
  | { status: "ready" }
  | { status: "askable" }
  | { status: "refused"; reason: BrowserRefusalReason }

function notificationState(environment: BrowserPlatformEnvironment): NotificationState {
  const host = environment.notifications
  if (!host) {
    return {
      status: "refused",
      reason: environment.install.homeScreenOnly && !environment.install.installed()
        ? "notifications-requires-install"
        : "notifications-unsupported",
    }
  }
  const permission = host.permission()
  if (permission === "granted") return { status: "ready" }
  if (permission === "denied") return { status: "refused", reason: "notifications-denied" }
  return { status: "askable" }
}

function notificationDelivery(environment: BrowserPlatformEnvironment): WorkspaceNotificationDelivery {
  const state = notificationState(environment)
  return state.status === "refused"
    ? { status: "refused", message: browserRefusalMessage[state.reason] }
    : { status: state.status }
}

function installState(environment: BrowserPlatformEnvironment): WorkspaceInstallState {
  if (environment.install.installed()) return { status: "installed" }
  if (environment.install.promptable()) return { status: "installable" }
  return { status: "manual", message: browserRefusalMessage["install-unsupported"] }
}

export function createBrowserPlatform(environment: BrowserPlatformEnvironment): WorkspacePlatform {
  return {
    dialogs: {
      // A directory handle from the File System Access API names a folder on the
      // device holding the browser, never one on the execution machine, so this
      // refuses rather than offering a picker that resolves the wrong filesystem.
      pickProjectDirectory: async (): Promise<WorkspaceDirectoryChoice> => ({
        status: "refused",
        message: browserRefusalMessage["dialogs-unsupported"],
      }),
    },
    notifications: {
      delivery: () => notificationDelivery(environment),
      request: async () => {
        const host = environment.notifications
        if (!host) return notificationDelivery(environment)
        try {
          await host.request()
        } catch {
          return { status: "refused", message: browserRefusalMessage["notifications-denied"] }
        }
        return notificationDelivery(environment)
      },
      notify: async (request: DesktopNotificationRequest) => {
        const state = notificationState(environment)
        if (state.status === "askable") throw new BrowserCapabilityError("notifications-not-allowed")
        if (state.status === "refused") throw new BrowserCapabilityError(state.reason)
        const copy = notificationCopy[request.kind]
        environment.notifications?.show({ title: copy.title, body: copy.body, tag: request.id })
      },
    },
    clipboard: {
      writeText: async (value: string) => {
        if (!environment.secureContext) throw new BrowserCapabilityError("clipboard-insecure-context")
        const clipboard = environment.clipboard
        if (!clipboard) throw new BrowserCapabilityError("clipboard-unsupported")
        try {
          await clipboard.writeText(value)
        } catch {
          throw new BrowserCapabilityError("clipboard-denied")
        }
      },
    },
    install: {
      state: () => installState(environment),
      prompt: async () => {
        if (environment.install.promptable()) {
          try {
            await environment.install.prompt()
          } catch {
            return installState(environment)
          }
        }
        return installState(environment)
      },
    },
  }
}

type InstallPromptEvent = {
  preventDefault(): void
  prompt(): Promise<unknown>
}

type BrowserNotificationConstructor = {
  new (title: string, options: { body: string; tag: string }): {
    onclick: ((event: Event) => unknown) | null
    close(): void
  }
  permission: string
  requestPermission(): Promise<unknown>
}

export type BrowserGlobals = {
  isSecureContext: boolean
  Notification?: BrowserNotificationConstructor | undefined
  navigator: {
    clipboard?: BrowserClipboardHost | undefined
    standalone?: boolean | undefined
  }
  matchMedia(query: string): { matches: boolean }
  addEventListener(type: string, listener: (event: Event) => void): void
  focus(): void
}

function permissionOf(value: string): BrowserNotificationPermission {
  if (value === "granted") return "granted"
  if (value === "denied") return "denied"
  return "default"
}

export function browserPlatformEnvironment(globals: BrowserGlobals): BrowserPlatformEnvironment {
  let deferredInstall: InstallPromptEvent | undefined
  let installed = globals.matchMedia("(display-mode: standalone)").matches
    || globals.navigator.standalone === true

  globals.addEventListener("beforeinstallprompt", (event: Event) => {
    const deferrable = event as unknown as InstallPromptEvent
    deferrable.preventDefault()
    deferredInstall = deferrable
  })
  globals.addEventListener("appinstalled", () => {
    installed = true
    deferredInstall = undefined
  })

  const notification = globals.Notification

  return {
    secureContext: globals.isSecureContext,
    clipboard: globals.navigator.clipboard,
    notifications: notification
      ? {
          permission: () => permissionOf(notification.permission),
          request: () => notification.requestPermission(),
          show: ({ title, body, tag }) => {
            const raised = new notification(title, { body, tag })
            raised.onclick = () => {
              globals.focus()
              raised.close()
            }
          },
        }
      : undefined,
    install: {
      homeScreenOnly: "standalone" in globals.navigator,
      installed: () => installed,
      promptable: () => deferredInstall !== undefined,
      prompt: async () => {
        const pending = deferredInstall
        deferredInstall = undefined
        await pending?.prompt()
      },
    },
  }
}
