import { join } from "node:path"

import { DomovoiDaemon } from "@getdomovoi/daemon"
import { app, BrowserWindow, ipcMain } from "electron"

let mainWindow: BrowserWindow | undefined
let localDaemon: DomovoiDaemon | undefined

async function ensureDaemon(): Promise<void> {
  const daemon = new DomovoiDaemon({ host: "127.0.0.1", port: 47831 })
  try {
    await daemon.start()
    localDaemon = daemon
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EADDRINUSE") throw error
  }
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
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"))
  }
}

ipcMain.on("window:minimize", () => mainWindow?.minimize())
ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on("window:close", () => mainWindow?.close())

app.whenReady().then(async () => {
  await ensureDaemon()
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  void localDaemon?.stop()
})
