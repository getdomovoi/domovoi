import { homedir } from "node:os"

import { holdServiceHandoffFence, installDaemonService, readDaemonServiceStatus, readLocalServiceHandoffRefusal, removeDaemonService } from "@getdomovoi/daemon"

import { DesktopDaemonService, nodeRuntimeFileSystem, stageDaemonRuntime } from "./daemon-service.js"
import type { DesktopDaemon } from "./desktop-daemon.js"

// J24: the login service, assembled on first use. index.ts loads this module
// with import() only when Settings first asks about the service, so none of
// it counts toward the main process's startup bundle. The shipped runtime is
// copied under the profile first, so the service never points into the app
// bundle.
export function createDesktopDaemonService(desktopDaemon: DesktopDaemon, app: { resourcesPath: string; version: string }): DesktopDaemonService {
  return new DesktopDaemonService({
    stageRuntime: () => stageDaemonRuntime({
      resourcesPath: app.resourcesPath,
      home: homedir(),
      version: app.version,
      platform: process.platform,
      fileSystem: nodeRuntimeFileSystem(),
    }),
    install: (options) => installDaemonService(options),
    status: () => readDaemonServiceStatus(),
    remove: () => removeDaemonService(),
    // The same check the renderer draws, applied to the daemon's own workspace.
    refusal: async () => {
      const endpoint = desktopDaemon.current()
      if (!endpoint || endpoint.kind === "refused") throw new Error("This app is not connected to a daemon")
      return readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })
    },
    // The same check inside the daemon, held from right before the stop until
    // the handoff settles, so no turn starts after the read above.
    fence: async () => {
      const endpoint = desktopDaemon.current()
      if (!endpoint || endpoint.kind === "refused") throw new Error("This app is not connected to a daemon")
      return holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    },
    daemon: {
      beginHandoff: () => desktopDaemon.beginHandoff(),
      endHandoff: () => desktopDaemon.endHandoff(),
      stopOwned: () => desktopDaemon.stopOwned(),
      attachOnly: () => desktopDaemon.attachOnly(),
      restart: () => desktopDaemon.restart(),
    },
  })
}
