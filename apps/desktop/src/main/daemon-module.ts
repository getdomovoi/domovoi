import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
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
  "serviceProfileMismatch",
  "updateDaemonService",
  "DaemonServiceRuntimeMissingError",
] as const

export type DaemonModule = Pick<typeof Daemon, (typeof daemonModuleExports)[number]>

// appPath: the app's own archive, which carries the digests packaging recorded.
export type DaemonModuleLocation = { isPackaged: boolean; resourcesPath: string; appPath?: string }

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

// Security review of #577 (P2): a packaged app imports its daemon only from
// files inside its own resources that match the digests packaging recorded
// (scripts/daemon-runtime.mjs, writeDaemonRuntimeManifest) and shipped inside
// app.asar, not beside the runtime. It proves the dist files imported are the
// ones this build shipped. Limits: dependencies under node_modules are covered
// only by where that directory resolves, and a process running as the same
// user can rewrite app.asar too (outside the threat model, ruled on #577).
async function verifyShippedDaemon(resourcesPath: string, appPath = ""): Promise<void> {
  const daemon = join(resourcesPath, "daemon-runtime", "daemon")
  const inside = join(await realpath(resourcesPath), "daemon-runtime", "daemon")
  for (const part of ["dist", "node_modules"]) {
    if (await realpath(join(daemon, part)) !== join(inside, part)) throw new Error(`${join(daemon, part)} leads outside this app's resources.`)
  }
  const manifestPath = join(appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`)
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  const expected: unknown = typeof manifest === "object" && manifest !== null && "dist" in manifest ? manifest.dist : undefined
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) throw new Error(`${manifestPath} is not a digest manifest.`)
  const digests = expected as Record<string, unknown>
  const dist = join(daemon, "dist")
  const names = (await readdir(dist)).sort()
  if (names.join("/") !== Object.keys(digests).sort().join("/")) throw new Error(`${dist} does not hold the files this build shipped.`)
  for (const name of names) {
    const path = join(dist, name)
    if (!(await lstat(path)).isFile() || createHash("sha256").update(await readFile(path)).digest("hex") !== digests[name]) throw new Error(`${path} does not match this build.`)
  }
}

// The values the first module took out of process.env, and the home directory
// the daemon pins them under.
export type InheritedCredentialHandOff = { take: () => Daemon.InheritedCredentialValues; homeDirectory: () => unknown }

export async function loadDaemonModule(
  location: DaemonModuleLocation,
  importer: (specifier: string) => Promise<Record<string, unknown>> = async (specifier) => {
    if (location.isPackaged) await verifyShippedDaemon(location.resourcesPath, location.appPath)
    return import(specifier) as Promise<Record<string, unknown>>
  },
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
