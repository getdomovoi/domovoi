import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("domovoiDesktop", {
  platform: process.platform,
  getRpcToken: () => ipcRenderer.invoke("domovoi:rpc-token") as Promise<string>,
  captureAnnotation: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("domovoi:capture-annotation", rect) as Promise<{
      mimeType: "image/png"
      width: number
      height: number
      data: string
    }>,
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
})
