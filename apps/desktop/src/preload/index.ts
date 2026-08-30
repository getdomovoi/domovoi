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
  notify: (request: { id: string; kind: string; sessionId: string }) =>
    ipcRenderer.invoke("domovoi:notify", request) as Promise<boolean>,
  onNotificationActivate: (listener: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId === "string") listener(sessionId)
    }
    ipcRenderer.on("domovoi:notification-activate", handler)
    return () => ipcRenderer.removeListener("domovoi:notification-activate", handler)
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
})
