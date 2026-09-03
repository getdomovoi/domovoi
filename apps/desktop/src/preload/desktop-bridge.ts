import type {
  DesktopDirectoryResult,
  DesktopOpenExternalRequest,
  DesktopWindowBridge,
} from "@getdomovoi/ui"

export type IpcRendererAdapter = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

type DesktopPlatform = DesktopWindowBridge["platform"]
type DesktopAnnotationCapture = Awaited<ReturnType<DesktopWindowBridge["captureAnnotation"]>>

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const maximumClipboardLength = 1_000_000
const maximumCaptureDimension = 2048
const maximumCaptureDataLength = 2_000_000

function absolutePath(value: unknown, platform: DesktopPlatform): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\0\r\n]/u.test(value)) return false
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value)
    : value.startsWith("/")
}

function directoryResult(value: unknown, platform: DesktopPlatform): DesktopDirectoryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop returned an invalid folder response")
  }
  const result = value as Record<string, unknown>
  if (result.status === "cancelled" && Object.keys(result).length === 1) return { status: "cancelled" }
  if (
    result.status === "selected"
    && Object.keys(result).sort().join(",") === "path,status"
    && absolutePath(result.path, platform)
  ) return { status: "selected", path: result.path }
  throw new Error("Desktop returned an invalid folder response")
}

function captureDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximumCaptureDimension
}

function captureResult(value: unknown): DesktopAnnotationCapture {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "data,height,mimeType,width"
  ) throw new Error("Desktop returned an invalid annotation capture response")
  const result = value as Record<string, unknown>
  if (
    result.mimeType !== "image/png"
    || !captureDimension(result.width)
    || !captureDimension(result.height)
    || typeof result.data !== "string"
    || result.data.length === 0
    || result.data.length > maximumCaptureDataLength
  ) throw new Error("Desktop returned an invalid annotation capture response")
  return { mimeType: "image/png", width: result.width, height: result.height, data: result.data }
}

function externalRequest(value: DesktopOpenExternalRequest, platform: DesktopPlatform): DesktopOpenExternalRequest {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "editor,path"
    || !absolutePath(value.path, platform)
    || !["system", "vscode", "vscode-insiders", "cursor", "zed"].includes(value.editor)
  ) throw new Error("External editor request is invalid")
  return value
}

function booleanResult(value: unknown, action: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Desktop returned an invalid ${action} response`)
  return value
}

export function createDesktopWindowBridge(
  ipc: IpcRendererAdapter,
  platform: DesktopPlatform,
): DesktopWindowBridge {
  return {
    platform,
    getRpcToken: async () => {
      const result = await ipc.invoke("domovoi:rpc-token")
      if (typeof result !== "string" || !result) throw new Error("Desktop authentication token is unavailable")
      return result
    },
    captureAnnotation: async (rect) => captureResult(await ipc.invoke("domovoi:capture-annotation", rect)),
    notify: async (request) => booleanResult(await ipc.invoke("domovoi:notify", request), "notification"),
    onNotificationActivate: (listener) => {
      const handler = (_event: unknown, sessionId: unknown) => {
        if (typeof sessionId === "string" && sessionIdPattern.test(sessionId)) listener(sessionId)
      }
      ipc.on("domovoi:notification-activate", handler)
      return () => ipc.removeListener("domovoi:notification-activate", handler)
    },
    openDirectory: async () => directoryResult(await ipc.invoke("domovoi:open-directory"), platform),
    readClipboardText: async () => {
      const result = await ipc.invoke("domovoi:clipboard-read")
      if (typeof result !== "string") throw new Error("Desktop returned invalid clipboard text")
      if (result.length > maximumClipboardLength) throw new Error("Clipboard text is too large")
      return result
    },
    writeClipboardText: async (value) => {
      if (typeof value !== "string") throw new Error("Clipboard text is invalid")
      if (value.length > maximumClipboardLength) throw new Error("Clipboard text is too large")
      return booleanResult(await ipc.invoke("domovoi:clipboard-write", value), "clipboard" )
    },
    openExternal: async (request) => booleanResult(
      await ipc.invoke("domovoi:open-external", externalRequest(request, platform)),
      "external editor",
    ),
    onDeepLink: (listener) => {
      const handler = (_event: unknown, sessionId: unknown) => {
        if (typeof sessionId === "string" && sessionIdPattern.test(sessionId)) listener(sessionId)
      }
      ipc.on("domovoi:deep-link", handler)
      ipc.send("domovoi:deep-link-ready")
      return () => {
        ipc.send("domovoi:deep-link-paused")
        ipc.removeListener("domovoi:deep-link", handler)
      }
    },
    minimize: () => ipc.send("window:minimize"),
    maximize: () => ipc.send("window:maximize"),
    close: () => ipc.send("window:close"),
  }
}
