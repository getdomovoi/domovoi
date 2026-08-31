import { contextBridge, ipcRenderer } from "electron"

import { createDesktopWindowBridge, type IpcRendererAdapter } from "./desktop-bridge.js"

if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
  throw new Error("Domovoi Desktop does not support this platform")
}

const ipc: IpcRendererAdapter = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) as Promise<unknown>,
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
}

contextBridge.exposeInMainWorld(
  "domovoiDesktop",
  createDesktopWindowBridge(ipc, process.platform),
)

if (process.argv.includes("--domovoi-launch-smoke")) {
  ipcRenderer.send("domovoi:launch-smoke-preload-ready")
  contextBridge.exposeInMainWorld("domovoiLaunchSmoke", {
    ready: () => ipcRenderer.send("domovoi:launch-smoke-ready"),
  })
}
