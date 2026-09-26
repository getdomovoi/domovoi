import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type * as Daemon from "@getdomovoi/daemon"

import { takeInheritedCredentials } from "./inherited-environment.js"

// fetzy, 2026-09-23 (#577): the app and the login service share one copy of
// the daemon. A packaged app loads its in-app daemon from the runtime it ships
// in resources (daemon-runtime/daemon), the same files the service runs, so
// the archive carries no daemon and no second copy of its dependencies. Out of
// a package (development, tests), the workspace package is loaded instead.

// What the app uses from the daemon: the local ownership seam, route
// verification, the handoff check and the handoff fence against an existing
// owner, and the login-service calls. None of them constructs a daemon in
// this process. The credential capture takes the values the app's first
// module held (inherited-environment.ts).
export const daemonModuleExports = [
  "acquireLocalDaemon",
  "verifyLocalFleetClientRoute",
  "captureInheritedCredentials",
  "readLocalServiceHandoffRefusal",
  "holdServiceHandoffFence",
  "installDaemonService",
  "readDaemonServiceStatus",
  "readDaemonServiceRuntimeVersion",
  "removeDaemonService",
  "updateDaemonService",
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

// The values the first module took out of process.env, and the home directory
// the daemon pins them under.
export type InheritedCredentialHandOff = { take: () => Daemon.InheritedCredentialValues; homeDirectory: () => unknown }

export async function loadDaemonModule(
  location: DaemonModuleLocation,
  importer: (specifier: string) => Promise<Record<string, unknown>> = (specifier) => import(specifier) as Promise<Record<string, unknown>>,
  credentials: InheritedCredentialHandOff = { take: takeInheritedCredentials, homeDirectory: () => homedir() },
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
  const module = loaded as unknown as DaemonModule
  // Owner ruling 2026-09-26 (#577, A): the pinning stays in the one daemon
  // copy, so the held values go to its capture as soon as it has loaded, and
  // only to a runtime that carries everything the app uses.
  module.captureInheritedCredentials(credentials.homeDirectory, credentials.take())
  return { module, from }
}
