import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("domovoiDesktop", {
  platform: process.platform,
  getRpcToken: () => ipcRenderer.invoke("domovoi:rpc-token") as Promise<string>,
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
})
