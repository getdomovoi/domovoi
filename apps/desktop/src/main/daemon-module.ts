import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
// copyParent: where the private checked copy is made (the system temporary
// directory by default). afterCheck: for tests, runs between check and load.
export type DaemonModuleLocation = {
  isPackaged: boolean
  resourcesPath: string
  appPath?: string
  copyParent?: string
  afterCheck?: () => Promise<void>
}

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

// Security review of #577 (P2), owner ruling 2026-09-26 (Q39 B): a packaged
// app loads its daemon only from a private copy of bytes it has checked. Every
// file of the shipped daemon, dist and node_modules alike, must match the
// digests packaging recorded (scripts/daemon-runtime.mjs,
// writeDaemonRuntimeManifest) inside app.asar, and the tree must hold exactly
// those files and links. Each file is read once, hashed, and those bytes are
// written to a fresh directory only this user can read, from which the daemon
// is imported: the check and the load read the same bytes, and a file swapped
// in the resources after its read is never loaded. The copy is removed when
// the process exits. Limits: a process running as the same user can write the
// copy or app.asar too (outside the threat model, ruled on #577), and a copy
// left by a crash stays in the temporary directory until it is cleared.
async function checkedDaemonCopy(location: DaemonModuleLocation): Promise<string> {
  const daemon = join(location.resourcesPath, "daemon-runtime", "daemon")
  const inside = join(await realpath(location.resourcesPath), "daemon-runtime", "daemon")
  for (const part of ["dist", "node_modules"]) {
    if (await realpath(join(daemon, part)) !== join(inside, part)) throw new Error(`${join(daemon, part)} leads outside this app's resources.`)
  }
  const manifestPath = join(location.appPath ?? "", "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`)
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const files = record(record(manifest)?.files)
  const links = record(record(manifest)?.links)
  if (!files || !links) throw new Error(`${manifestPath} is not a digest manifest.`)
  const found: { files: string[]; links: string[] } = { files: [], links: [] }
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), key)
      else if (entry.isFile()) found.files.push(key)
      else if (entry.isSymbolicLink()) found.links.push(key)
      else throw new Error(`${daemon} does not hold the files this build shipped.`)
    }
  }
  await walk(daemon, "")
  const same = (keys: string[], expected: Record<string, unknown>) => keys.sort().join("\n") === Object.keys(expected).sort().join("\n")
  if (!same(found.files, files) || !same(found.links, links)) throw new Error(`${daemon} does not hold the files this build shipped.`)
  const copy = await mkdtemp(join(location.copyParent ?? tmpdir(), "domovoi-daemon-"))
  process.once("exit", () => rmSync(copy, { recursive: true, force: true }))
  try {
    for (const key of found.files) {
      const path = join(daemon, ...key.split("/"))
      const expected = record(files[key])
      const bytes = await readFile(path)
      if (createHash("sha256").update(bytes).digest("hex") !== expected?.sha256) throw new Error(`${path} does not match this build.`)
      const target = join(copy, ...key.split("/"))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: "wx", mode: expected.executable === true ? 0o700 : 0o600 })
    }
    for (const key of found.links) {
      const path = join(daemon, ...key.split("/"))
      const text = await readlink(path)
      const target = join(copy, ...key.split("/"))
      const into = relative(copy, resolve(dirname(target), text))
      if (text !== links[key] || into === ".." || into.startsWith(`..${sep}`) || isAbsolute(into)) throw new Error(`${path} does not match this build.`)
      await mkdir(dirname(target), { recursive: true })
      await symlink(text, target)
    }
    await location.afterCheck?.()
    return copy
  } catch (cause) {
    await rm(copy, { recursive: true, force: true })
    throw cause
  }
}

// The values the first module took out of process.env, and the home directory
// the daemon pins them under.
export type InheritedCredentialHandOff = { take: () => Daemon.InheritedCredentialValues; homeDirectory: () => unknown }

export async function loadDaemonModule(
  location: DaemonModuleLocation,
  importer?: (specifier: string) => Promise<Record<string, unknown>>,
  credentials: InheritedCredentialHandOff = { take: takeInheritedCredentials, homeDirectory: () => homedir() },
): Promise<{ module: DaemonModule; from: string }> {
  let from = daemonModuleSpecifier(location)
  let loaded: Record<string, unknown>
  try {
    if (importer) loaded = await importer(from)
    else {
      if (location.isPackaged) from = pathToFileURL(join(await checkedDaemonCopy(location), "dist", "public.js")).href
      loaded = await import(from) as Record<string, unknown>
    }
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
