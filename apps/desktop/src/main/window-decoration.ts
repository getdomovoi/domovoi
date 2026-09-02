export type WindowDecoration = "domovoi" | "system"

export type WindowFrameOptions = {
  frame: boolean
  titleBarStyle: "hiddenInset" | "hidden" | "default"
  trafficLightPosition?: { x: number; y: number }
}

const windowDecorations = new Set<WindowDecoration>(["domovoi", "system"])

export const windowDecorationFileName = "window-decoration.json"

export function isWindowDecoration(value: unknown): value is WindowDecoration {
  return typeof value === "string" && windowDecorations.has(value as WindowDecoration)
}

export function serializeWindowDecoration(decoration: WindowDecoration): string {
  return JSON.stringify({ version: 1, decoration })
}

export function readWindowDecoration(readFile: () => string): WindowDecoration {
  try {
    const parsed: unknown = JSON.parse(readFile())
    if (typeof parsed !== "object" || parsed === null) return "domovoi"
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || !isWindowDecoration(record.decoration)) return "domovoi"
    return record.decoration
  } catch {
    return "domovoi"
  }
}

export function windowFrameOptions(
  decoration: WindowDecoration,
  platform: NodeJS.Platform,
): WindowFrameOptions {
  if (decoration === "system") return { frame: true, titleBarStyle: "default" }
  if (platform === "darwin") {
    return {
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 14 },
    }
  }
  return { frame: false, titleBarStyle: "hidden" }
}
