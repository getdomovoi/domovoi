import { join } from "node:path"
import { randomBytes } from "node:crypto"

import { DomovoiDaemon } from "@getdomovoi/daemon"
import { app, BrowserWindow, dialog, ipcMain } from "electron"

import { startOwnedDaemon } from "./owned-daemon.js"
import { captureAnnotationPng } from "./annotation-capture.js"

let mainWindow: BrowserWindow | undefined
let localDaemon: DomovoiDaemon | undefined
const rpcToken = process.env.DOMOVOI_AUTH_TOKEN ?? randomBytes(32).toString("base64url")

async function ensureDaemon(): Promise<void> {
  const daemon = new DomovoiDaemon({ host: "127.0.0.1", port: 47831, authToken: rpcToken })
  localDaemon = await startOwnedDaemon(daemon)
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
ipcMain.handle("domovoi:rpc-token", () => rpcToken)
ipcMain.handle("domovoi:capture-annotation", async (event, rect: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Annotation capture sender is not authorized")
  }
  return captureAnnotationPng(mainWindow.webContents, rect as {
    x: number
    y: number
    width: number
    height: number
  })
})

app.whenReady().then(async () => {
  await ensureDaemon()
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown daemon startup failure"
  dialog.showErrorBox("Domovoi could not start", message)
  app.quit()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  void localDaemon?.stop()
})
