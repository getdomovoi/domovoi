import { homedir } from "node:os"
import { posix, win32 } from "node:path"

import type { DaemonModule } from "./daemon-module.js"
import { DesktopDaemonService } from "./daemon-service.js"
import type { DesktopDaemon } from "./desktop-daemon.js"

// J24: the login service, assembled on first use. index.ts loads this module
// with import() only when Settings first asks about the service, so none of
// it counts toward the main process's startup bundle. The shipped runtime is
// copied under the profile first, so the service never points into the app
// bundle. The service calls come from the daemon index.ts loaded at startup
// (daemon-module.ts), never from a static import (#577, one copy).
//
// Security review round 2 of #577 (P1): every service call acts for the profile
// this app's daemon runs, named by the environment its acquisition reads. The
// install writes that profile, and each call checks the saved service's
// profile against it again under the service-operation lease. home and
// environment default to this process's; tests pass their own.
export function createDesktopDaemonService(
  desktopDaemon: DesktopDaemon,
  app: { resourcesPath: string; version: string; home?: string; environment?: NodeJS.ProcessEnv; dataDirectory?: string },
  daemon: DaemonModule,
): DesktopDaemonService {
  const home = app.home ?? homedir()
  const environment = app.environment ?? process.env
  const profileDirectory = environment.DOMOVOI_PROFILE_DIR
  const profile = profileDirectory === undefined ? {} : { DOMOVOI_PROFILE_DIR: profileDirectory }
  // Where the runtime copies are published, and so where unused ones are
  // looked for (#635).
  const copies = profileDirectory ?? (process.platform === "win32" ? win32 : posix).join(home, ".domovoi")
  return new DesktopDaemonService({
    // Q408 A: the daemon's own copy routine, the one `domovoid service
    // install` uses when run from the app's runtime.
    stageRuntime: (operation) => daemon.prepareDaemonRuntime({
      operation,
      resourcesPath: app.resourcesPath,
      profileDirectory: copies,
      version: app.version,
      ...(app.dataDirectory === undefined ? {} : { dataDirectory: app.dataDirectory }),
      platform: process.platform,
      fileSystem: daemon.nodeRuntimeFileSystem(),
    }),
    install: (options) => daemon.installDaemonService({ ...options, environment: profile }),
    status: () => daemon.readDaemonServiceStatus(),
    // The profile this app's daemon runs, read as its acquisition reads it,
    // against the one the saved service configuration names.
    profile: async () => daemon.serviceProfileMismatch({ environment, homeDirectory: home }),
    remove: () => daemon.removeDaemonService(undefined, { environment: profile }),
    update: (options) => daemon.updateDaemonService({ ...options, environment: profile }),
    runtimeCopy: () => daemon.readDaemonServiceRuntimeCopy(),
    removeUnusedRuntimes: (options) => daemon.removeUnusedDaemonRuntimes({ ...options, profileDirectory: copies }),
    // The same check the renderer draws, applied to the daemon's own workspace.
    refusal: async () => {
      const endpoint = desktopDaemon.current()
      if (!endpoint || endpoint.kind === "refused") throw new Error("This app is not connected to a daemon")
      return daemon.readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })
    },
    // The same check inside the daemon, held from right before the stop until
    // the handoff settles, so no turn starts after the read above.
    fence: async () => {
      const endpoint = desktopDaemon.current()
      if (!endpoint || endpoint.kind === "refused") throw new Error("This app is not connected to a daemon")
      return daemon.holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
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
