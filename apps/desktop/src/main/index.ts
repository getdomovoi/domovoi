import { homedir } from "node:os"
import { realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"

import { DomovoiDaemon } from "@getdomovoi/daemon"
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron"

import { OwnedDaemonLifecycle, startDesktop } from "./owned-daemon.js"
import {
  isAuthorizedRendererEvent,
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
let rendererDeepLinkSink: ((link: DesktopDeepLink) => void) | undefined
const desktopPlatform: DesktopPlatform = process.platform
const launchSmoke = process.env.DOMOVOI_DESKTOP_LAUNCH_SMOKE === "1"
let launchSmokeStage = "main"
let launchSmokeTimeout: ReturnType<typeof setTimeout> | undefined
const rpcToken = process.env.DOMOVOI_AUTH_TOKEN ?? randomBytes(32).toString("base64url")
const deepLinks = new DesktopDeepLinkQueue()
const ownedDaemon = new OwnedDaemonLifecycle((error) => {
  console.error("Owned daemon failed to stop during desktop shutdown", error)
})
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

async function ensureDaemon(): Promise<void> {
  const daemon = new DomovoiDaemon({ host: "127.0.0.1", port: 47831, authToken: rpcToken })
  await ownedDaemon.start(daemon)
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
  const isMac = process.platform === "darwin"
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#19191b",
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac ? { trafficLightPosition: { x: 16, y: 14 } } : {}),
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
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error(`Desktop renderer exited unexpectedly: ${details.reason} (${details.exitCode})`)
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

  mainRendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    bundledRendererPath: join(import.meta.dirname, "../renderer/index.html"),
  })
  if (mainRendererTarget.kind === "url") {
    void mainWindow.loadURL(mainRendererTarget.url)
  } else {
    void mainWindow.loadFile(mainRendererTarget.path)
  }
}

registerDesktopIpc(ipcMain, {
  authorized: authorizedDesktopSender,
  mainWindow: () => mainWindow,
  focusMainWindow,
  rpcToken,
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
      if (launchSmokeTimeout) clearTimeout(launchSmokeTimeout)
      console.info("DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK")
      app.exit(0)
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
    if (launchSmoke) {
      launchSmokeTimeout = setTimeout(() => {
        console.error(`Domovoi desktop launch smoke stopped after ${launchSmokeStage} readiness`)
        app.exit(1)
      }, 10_000)
      createWindow()
      return
    }
    await startDesktop(createWindow, async () => {
      await ensureDaemon()
      startupMetrics.mark("daemon-ready")
    })
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch(() => {
    dialog.showErrorBox(
      "Domovoi could not start",
      "The local daemon did not start. Check Domovoi logs and try again.",
    )
    app.quit()
  })
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", (event) => {
  ownedDaemon.beforeQuit(event, () => app.quit())
})
