import { homedir } from "node:os"

import { captureInheritedCredentials } from "@getdomovoi/daemon"

// The first import of the desktop main process, so this runs before any other
// module of the app: before the startup callback, before any window, daemon,
// terminal or helper exists to inherit process.env. The daemon bearer, its
// credential path and the relay credential file leave process.env here and are
// pinned to their profile for the daemon's own acquisition. The development
// daemon token leaves it too, and only the development seam reads it back.
const developmentDaemonTokenVariable = "DOMOVOI_DEV_DAEMON_TOKEN"
const developmentDaemonToken = process.env[developmentDaemonTokenVariable]
delete process.env[developmentDaemonTokenVariable]
captureInheritedCredentials(() => homedir())

// The environment the development loop decides from: process.env plus the
// development daemon token it was started with. Never passed to a child.
export function developmentEnvironment(): NodeJS.ProcessEnv {
  return developmentDaemonToken === undefined
    ? process.env
    : { ...process.env, [developmentDaemonTokenVariable]: developmentDaemonToken }
}
