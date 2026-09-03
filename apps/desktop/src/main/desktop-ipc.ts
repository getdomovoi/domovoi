import { captureAnnotationPng, type CaptureTarget } from "./annotation-capture.js"
import type { DesktopDeepLink } from "./deep-links.js"
import {
  chooseDirectory,
  type DesktopFileSystem,
  type DesktopPlatform,
  type OpenDirectoryDialog,
} from "./desktop-platform.js"
import type { RendererIpcEvent } from "./renderer-security.js"

type DesktopRendererSender = {
  send(channel: "domovoi:deep-link" | "domovoi:notification-activate", sessionId: string): void
}

export type DesktopIpcEvent = RendererIpcEvent & {
  readonly sender: DesktopRendererSender
}

export type DesktopIpcMain = {
  handle(channel: string, listener: (event: DesktopIpcEvent, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: DesktopIpcEvent, ...args: unknown[]) => void): unknown
}

export type DesktopIpcWindow = {
  readonly webContents: CaptureTarget & DesktopRendererSender
  isDestroyed(): boolean
  isMaximized(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
}

export type DesktopDeepLinkSink = (link: DesktopDeepLink) => void

export type DesktopIpcDependencies = {
  authorized(event: DesktopIpcEvent): boolean
  mainWindow(): DesktopIpcWindow | undefined
  focusMainWindow(): void
  rpcToken: string
  platform: DesktopPlatform
  fileSystem: DesktopFileSystem
  openDirectoryDialog: OpenDirectoryDialog
  clipboard: {
    readText(): Promise<string>
    writeText(value: unknown): Promise<boolean>
  }
  externalTargets: {
    allowRoot(path: string): void
    open(value: unknown): Promise<boolean>
  }
  notifications: {
    notify(input: unknown, activate: (sessionId: string) => void): boolean
  }
  deepLinks: {
    enqueue(link: DesktopDeepLink): void
    ready(sink: DesktopDeepLinkSink): void
    pause(sink?: DesktopDeepLinkSink): void
  }
  rendererDeepLinkSink: {
    get(): DesktopDeepLinkSink | undefined
    set(sink: DesktopDeepLinkSink | undefined): void
  }
  launchSmoke: {
    enabled: boolean
    preloadReady(): void
    ready(): void
    unauthorized(): void
  }
}

export function registerDesktopIpc(ipcMain: DesktopIpcMain, deps: DesktopIpcDependencies): void {
  ipcMain.on("window:minimize", (event) => {
    if (deps.authorized(event)) deps.mainWindow()?.minimize()
  })
  ipcMain.on("window:maximize", (event) => {
    if (!deps.authorized(event)) return
    const window = deps.mainWindow()
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.on("window:close", (event) => {
    if (deps.authorized(event)) deps.mainWindow()?.close()
  })
  ipcMain.handle("domovoi:rpc-token", (event) => {
    if (!deps.authorized(event)) throw new Error("Desktop request is not authorized")
    return deps.rpcToken
  })
  ipcMain.handle("domovoi:capture-annotation", async (event, rect: unknown) => {
    const window = deps.authorized(event) ? deps.mainWindow() : undefined
    if (!window) throw new Error("Annotation capture sender is not authorized")
    return captureAnnotationPng(window.webContents, rect as {
      x: number
      y: number
      width: number
      height: number
    })
  })
  ipcMain.handle("domovoi:notify", (event, request: unknown) => {
    if (!deps.authorized(event)) return false
    return deps.notifications.notify(request, (sessionId) => {
      const window = deps.mainWindow()
      if (!window || window.isDestroyed()) return
      deps.focusMainWindow()
      window.webContents.send("domovoi:notification-activate", sessionId)
    })
  })

  ipcMain.handle("domovoi:open-directory", async (event) => {
    const window = deps.authorized(event) ? deps.mainWindow() : undefined
    if (!window) throw new Error("Desktop request is not authorized")
    const result = await chooseDirectory(deps.openDirectoryDialog, deps.fileSystem, deps.platform)
    if (result.status === "selected") deps.externalTargets.allowRoot(result.path)
    return result
  })

  ipcMain.handle("domovoi:clipboard-read", (event) => {
    if (!deps.authorized(event)) throw new Error("Desktop request is not authorized")
    return deps.clipboard.readText()
  })

  ipcMain.handle("domovoi:clipboard-write", (event, value: unknown) => {
    if (!deps.authorized(event)) throw new Error("Desktop request is not authorized")
    return deps.clipboard.writeText(value)
  })

  ipcMain.handle("domovoi:open-external", (event, request: unknown) => {
    if (!deps.authorized(event)) throw new Error("Desktop request is not authorized")
    return deps.externalTargets.open(request)
  })

  ipcMain.on("domovoi:deep-link-ready", (event) => {
    if (!deps.authorized(event)) return
    const previous = deps.rendererDeepLinkSink.get()
    if (previous) deps.deepLinks.pause(previous)
    const sink: DesktopDeepLinkSink = (link) => {
      if (!deps.authorized(event)) {
        deps.deepLinks.pause(sink)
        if (deps.rendererDeepLinkSink.get() === sink) deps.rendererDeepLinkSink.set(undefined)
        deps.deepLinks.enqueue(link)
        return
      }
      event.sender.send("domovoi:deep-link", link.sessionId)
    }
    deps.rendererDeepLinkSink.set(sink)
    deps.deepLinks.ready(sink)
  })

  ipcMain.on("domovoi:deep-link-paused", (event) => {
    const sink = deps.authorized(event) ? deps.rendererDeepLinkSink.get() : undefined
    if (!sink) return
    deps.deepLinks.pause(sink)
    deps.rendererDeepLinkSink.set(undefined)
  })

  ipcMain.on("domovoi:launch-smoke-preload-ready", (event) => {
    if (deps.launchSmoke.enabled && event.sender === deps.mainWindow()?.webContents) deps.launchSmoke.preloadReady()
  })

  ipcMain.on("domovoi:launch-smoke-ready", (event) => {
    if (!deps.launchSmoke.enabled) return
    if (!deps.authorized(event)) {
      deps.launchSmoke.unauthorized()
      return
    }
    deps.launchSmoke.ready()
  })
}
