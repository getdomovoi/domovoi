import { relative, sep } from "node:path"

import type { Plugin } from "vite"

// Every watched save prints exactly one line, so an unchanged window always has
// a line beside it saying which change was supposed to happen. A renderer save
// keeps the window and its state. A main or preload save relaunches the window,
// and if the relaunch does not follow, the printed promise is visibly broken
// rather than missing. A save that is neither prints nothing, because nobody
// expects a window change from a document or a test.
export type WatchedChange = "renderer" | "relaunch" | "none"

const rendererPaths = ["packages/ui/src/", "apps/desktop/src/renderer/", "apps/desktop/src/dev/"]
const relaunchPaths = ["apps/desktop/src/main/", "apps/desktop/src/preload/"]

export function classifyChange(path: string): WatchedChange {
  if (path.startsWith("..")) return "none"
  if (/\.(test|dom\.test)\.[cm]?[jt]sx?$/.test(path)) return "none"
  if (relaunchPaths.some((prefix) => path.startsWith(prefix))) return "relaunch"
  if (rendererPaths.some((prefix) => path.startsWith(prefix))) return "renderer"
  return "none"
}

export function changeLine(path: string): string | null {
  switch (classifyChange(path)) {
    case "renderer":
      return `[loop] renderer updated: ${path}. Fixture state kept.`
    case "relaunch":
      return `[loop] main or preload edit: ${path}. The window relaunches now; watch for the boot line below.`
    case "none":
      return null
  }
}

export function reloadLine(path: string): string {
  return `[loop] Fast Refresh could not apply ${path}, so the renderer reloaded and the window state is gone. Fixture state kept.`
}

export function devLoopReporter(options: { root: string; log?: (line: string) => void }): Plugin {
  const log = options.log ?? console.log
  return {
    name: "domovoi-dev-loop-reporter",
    apply: "serve",
    configureServer(server) {
      let pending: string | null = null
      server.watcher.on("change", (file) => {
        // The prefixes are written with forward slashes; Windows reports
        // backslashes, so a save there matched none of them.
        const path = relative(options.root, file).split(sep).join("/")
        const line = changeLine(path)
        if (!line) return
        log(line)
        pending = classifyChange(path) === "renderer" ? path : null
      })
      const channel = server.hot ?? server.ws
      const send = channel.send.bind(channel)
      channel.send = ((payload: unknown, ...rest: unknown[]) => {
        if (pending && typeof payload === "object" && payload !== null && "type" in payload) {
          if ((payload as { type: unknown }).type === "full-reload") {
            log(reloadLine(pending))
            pending = null
          }
        }
        return (send as (...args: unknown[]) => unknown)(payload, ...rest)
      }) as typeof channel.send
    },
  }
}
