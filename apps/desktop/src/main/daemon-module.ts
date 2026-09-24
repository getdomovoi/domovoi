import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type * as Daemon from "@getdomovoi/daemon"

// fetzy, 2026-09-23 (#577): the app and the login service share one copy of
// the daemon. A packaged app loads its in-app daemon from the runtime it ships
// in resources (daemon-runtime/daemon), the same files the service runs, so
// the archive carries no daemon and no second copy of its dependencies. Out of
// a package (development, tests), the workspace package is loaded instead.

// What the app uses from the daemon: the local ownership seam, route
// verification against an existing owner, and the login-service calls. None
// of them constructs a daemon in this process.
export const daemonModuleExports = [
  "acquireLocalDaemon",
  "verifyLocalFleetClientRoute",
  "readLocalServiceHandoffRefusal",
  "installDaemonService",
  "readDaemonServiceStatus",
  "removeDaemonService",
  "DaemonServiceRuntimeMissingError",
] as const

export type DaemonModule = Pick<typeof Daemon, (typeof daemonModuleExports)[number]>

export type DaemonModuleLocation = { isPackaged: boolean; resourcesPath: string }

export function daemonModuleSpecifier({ isPackaged, resourcesPath }: DaemonModuleLocation): string {
  return isPackaged
    ? pathToFileURL(join(resourcesPath, "daemon-runtime", "daemon", "dist", "public.js")).href
    : "@getdomovoi/daemon"
}

// The shipped runtime is missing, cannot be imported, or does not carry what
// the app uses. Startup names it rather than dying with Electron's own error.
export class DaemonRuntimeLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DaemonRuntimeLoadError"
  }
}

export async function loadDaemonModule(
  location: DaemonModuleLocation,
  importer: (specifier: string) => Promise<Record<string, unknown>> = (specifier) => import(specifier) as Promise<Record<string, unknown>>,
): Promise<{ module: DaemonModule; from: string }> {
  const from = daemonModuleSpecifier(location)
  let loaded: Record<string, unknown>
  try {
    loaded = await importer(from)
  } catch (cause) {
    throw new DaemonRuntimeLoadError(`${from} could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const missing = daemonModuleExports.filter((name) => typeof loaded[name] !== "function")
  if (missing.length) throw new DaemonRuntimeLoadError(`${from} is missing ${missing.join(", ")}. The shipped daemon runtime does not match this app.`)
  return { module: loaded as unknown as DaemonModule, from }
}
