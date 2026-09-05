import { homedir, hostname } from "node:os"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { acquireLocalDaemon } from "@getdomovoi/daemon"
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, session, shell } from "electron"

import { DesktopDaemon } from "./desktop-daemon.js"
import { configureLaunchSmokeProfile } from "./launch-smoke-profile.js"
import { DesktopDaemonLifecycle, startDesktop } from "./daemon-lifecycle.js"
import { daemonErrorLogSink, recordStartupFailure } from "./startup-failure.js"
import {
  isAuthorizedRendererEvent,
  isTrustedRendererFrameUrl,
  rendererContentSecurityPolicy,
  resolveRendererTarget,
  type RendererTarget,
} from "./renderer-security.js"
import { DesktopStartupMetrics } from "./startup-metrics.js"
import { DesktopNotificationController } from "./desktop-notifications.js"
import { registerDesktopIpc, type DesktopIpcEvent } from "./desktop-ipc.js"
import {
  ExternalTargetController,
  SafeClipboard,
  type DesktopPlatform,
} from "./desktop-platform.js"
import {
  isWindowDecoration,
  readWindowDecoration,
  serializeWindowDecoration,
  windowDecorationFileName,
  windowFrameOptions,
  type WindowDecoration,
} from "./window-decoration.js"
import {
  DesktopDeepLinkQueue,
  deepLinksFromArgv,
  parseDomovoiDeepLink,
  type DesktopDeepLink,
} from "./deep-links.js"

if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
  throw new Error("Domovoi Desktop does not support this platform")
}

let mainWindow: BrowserWindow | undefined
let mainRendererTarget: RendererTarget | undefined
let activeWindowDecoration: WindowDecoration = "domovoi"
let rendererDeepLinkSink: ((link: DesktopDeepLink) => void) | undefined
const desktopPlatform: DesktopPlatform = process.platform
const launchSmoke = process.env.DOMOVOI_DESKTOP_LAUNCH_SMOKE === "1"
if (launchSmoke) {
  configureLaunchSmokeProfile(app, process.env.DOMOVOI_LAUNCH_SMOKE_PROFILE, homedir())
}
let launchSmokeStage = "main"
let launchSmokeTimeout: ReturnType<typeof setTimeout> | undefined
let launchSmokeFinishing = false
const deepLinks = new DesktopDeepLinkQueue()
const startupMetrics = new DesktopStartupMetrics({
  enabled: process.env.DOMOVOI_PERFORMANCE_REPORT === "1",
})
const desktopFileSystem = { realpath, stat }
const safeClipboard = new SafeClipboard({
  readText: () => clipboard.readText(),
  writeText: (value) => clipboard.writeText(value),
})
const externalTargets = new ExternalTargetController({
  openPath: (path) => shell.openPath(path),
  openExternal: (url) => shell.openExternal(url),
}, desktopFileSystem, {
  platform: desktopPlatform,
  allowedRoots: [join(homedir(), ".domovoi", "worktrees")],
})
const desktopNotifications = new DesktopNotificationController({
  isSupported: () => Notification.isSupported(),
  create: (options) => {
    const notification = new Notification(options)
    return {
      once: (event, listener) => {
        if (event === "click") notification.once("click", listener)
        else notification.once("failed", listener)
      },
      show: () => notification.show(),
    }
  },
})

function domovoiMainLogPath(): string {
  return join(app.getPath("logs"), "domovoi-main.log")
}

function appendDomovoiMainLog(logPath: string, text: string): void {
  appendFileSync(logPath, text)
}

// Attach to the profile's owner, or own a daemon only when the profile is free.
const desktopDaemon = new DesktopDaemon(acquireLocalDaemon, () => ({
  environment: process.env,
  homeDirectory: homedir(),
  machineLabel: hostname(),
  errorSink: daemonErrorLogSink(domovoiMainLogPath(), appendDomovoiMainLog),
}))
const daemonLifecycle = new DesktopDaemonLifecycle(() => desktopDaemon.release(), (error) => {
  console.error("Local daemon failed to release during desktop shutdown", error)
})

function windowDecorationPath(): string {
  return join(app.getPath("userData"), windowDecorationFileName)
}

function storedWindowDecoration(): WindowDecoration {
  return readWindowDecoration(() => readFileSync(windowDecorationPath(), "utf8"))
}

function persistWindowDecoration(decoration: WindowDecoration): boolean {
  try {
    writeFileSync(windowDecorationPath(), serializeWindowDecoration(decoration), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function acceptDeepLink(link: DesktopDeepLink): void {
  focusMainWindow()
  deepLinks.enqueue(link)
}

function authorizedDesktopSender(event: DesktopIpcEvent): boolean {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && mainRendererTarget
    && isAuthorizedRendererEvent(event, mainWindow.webContents, mainRendererTarget),
  )
}

function createWindow(): void {
  activeWindowDecoration = storedWindowDecoration()
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#19191b",
    ...windowFrameOptions(activeWindowDecoration, process.platform),
    show: false,
    webPreferences: {
      additionalArguments: launchSmoke ? ["--domovoi-launch-smoke"] : [],
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  startupMetrics.mark("window-created")

  // A renderer that dies leaves an empty window, so it is reloaded rather
  // than logged only. An intentional renderer exit must not come back.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Desktop renderer exited unexpectedly: ${details.reason} (${details.exitCode})`)
    if (details.reason !== "clean-exit") mainWindow?.webContents.reload()
  })
  if (launchSmoke) {
    mainWindow.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") {
        console.error(`Desktop renderer ${details.level}: ${details.message}`)
      }
    })
    mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`Desktop preload failed (${preloadPath}): ${error.message}`)
    })
    mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) console.error(`Desktop renderer failed to load ${url}: ${code} ${description}`)
    })
  }

  mainWindow.once("ready-to-show", () => {
    startupMetrics.mark("ready-to-show")
    if (!launchSmoke) mainWindow?.show()
  })
  mainWindow.once("closed", () => {
    if (rendererDeepLinkSink) deepLinks.pause(rendererDeepLinkSink)
    rendererDeepLinkSink = undefined
    mainRendererTarget = undefined
    mainWindow = undefined
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault())

  const target = resolveRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    bundledRendererPath: join(import.meta.dirname, "../renderer/index.html"),
  })
  mainRendererTarget = target
  const window = mainWindow
  const load = () => {
    if (!window.isDestroyed()) void (target.kind === "url" ? window.loadURL(target.url) : window.loadFile(target.path))
  }
  // The document's policy names the acquired endpoint, so the load waits.
  void desktopDaemon.acquire().then(load, () => {})
}

// Served with the document so connect-src can name the acquired endpoint.
function serveRendererPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const acquisition = desktopDaemon.current()
    const trusted = details.resourceType === "mainFrame" && mainRendererTarget
      && isTrustedRendererFrameUrl(details.url, mainRendererTarget)
    callback(trusted ? {
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          rendererContentSecurityPolicy(acquisition?.kind === "refused" ? undefined : acquisition?.url),
        ],
      },
    } : {})
  })
}

ipcMain.handle("domovoi:window-decoration-get", (event) => {
  if (!authorizedDesktopSender(event)) throw new Error("Desktop request is not authorized")
  return activeWindowDecoration
})
ipcMain.handle("domovoi:window-decoration-set", (event, decoration: unknown) => {
  if (!authorizedDesktopSender(event)) throw new Error("Desktop request is not authorized")
  if (!isWindowDecoration(decoration)) throw new Error("Window decoration is invalid")
  return persistWindowDecoration(decoration)
})

registerDesktopIpc(ipcMain, {
  authorized: authorizedDesktopSender,
  mainWindow: () => mainWindow,
  focusMainWindow,
  rpcEndpoint: () => desktopDaemon.acquire(),
  reconnectRpcEndpoint: () => desktopDaemon.reacquire(),
  platform: desktopPlatform,
  fileSystem: desktopFileSystem,
  openDirectoryDialog: {
    showOpenDirectory: () => dialog.showOpenDialog(mainWindow!, {
      title: "Open a project",
      buttonLabel: "Open project",
      properties: ["openDirectory"],
    }),
  },
  clipboard: safeClipboard,
  externalTargets,
  notifications: desktopNotifications,
  deepLinks,
  rendererDeepLinkSink: {
    get: () => rendererDeepLinkSink,
    set: (sink) => { rendererDeepLinkSink = sink },
  },
  launchSmoke: {
    enabled: launchSmoke,
    preloadReady: () => { launchSmokeStage = "preload" },
    ready: () => {
      if (launchSmokeFinishing) return
      launchSmokeFinishing = true
      if (desktopDaemon.current()?.kind !== "owned") {
        console.error("Desktop launch smoke did not acquire its own production daemon")
        app.exit(1)
        return
      }
      launchSmokeStage = "shutdown"
      void desktopDaemon.release().then(() => {
        if (launchSmokeTimeout) clearTimeout(launchSmokeTimeout)
        console.info("DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK")
        app.exit(0)
      }, (error: unknown) => {
        console.error("Desktop launch smoke could not release its daemon", error)
        app.exit(1)
      })
    },
    failed: (message) => {
      console.error(`Desktop launch smoke renderer failed: ${message}`)
      app.exit(1)
    },
    unauthorized: () => {
      console.error("Domovoi desktop launch smoke renderer sender was not authorized")
      app.exit(1)
    },
  },
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  if (!launchSmoke) {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient("domovoi", process.execPath, [resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient("domovoi")
    }
  }

  for (const link of deepLinksFromArgv(process.argv)) deepLinks.enqueue(link)

  app.on("second-instance", (_event, commandLine) => {
    focusMainWindow()
    for (const link of deepLinksFromArgv(commandLine)) acceptDeepLink(link)
  })

  app.on("open-url", (event, url) => {
    event.preventDefault()
    const link = parseDomovoiDeepLink(url)
    if (link) acceptDeepLink(link)
  })

  app.whenReady().then(async () => {
    startupMetrics.mark("app-ready")
    serveRendererPolicy()
    if (launchSmoke) {
      const budget = Number(process.env.DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS)
      if (!Number.isSafeInteger(budget) || budget < 1 || budget > 2_147_483_647) {
        throw new Error("Desktop launch smoke requires a bounded launch budget")
      }
      launchSmokeTimeout = setTimeout(() => {
        console.error(`Domovoi desktop launch smoke stopped after ${launchSmokeStage} readiness`)
        app.exit(1)
      }, budget)
    }
    await startDesktop(createWindow, async () => {
      const acquired = await desktopDaemon.acquire()
      if (launchSmoke && acquired.kind !== "owned") {
        throw new Error(acquired.kind === "refused" ? acquired.message : "Desktop launch smoke attached instead of owning")
      }
      startupMetrics.mark("daemon-ready")
    })
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error: unknown) => {
    if (launchSmoke) {
      console.error("Desktop launch smoke could not start", error)
      app.exit(1)
      return
    }
    const detail = recordStartupFailure({
      error,
      logPath: domovoiMainLogPath(),
      append: appendDomovoiMainLog,
    })
    dialog.showErrorBox("Domovoi could not start", detail)
    app.quit()
  })
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", (event) => {
  daemonLifecycle.beforeQuit(event, () => app.quit())
})
