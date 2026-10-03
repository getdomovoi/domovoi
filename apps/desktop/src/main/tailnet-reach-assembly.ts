import { execFile } from "node:child_process"
import { randomInt } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, rm, rmdir, utimes, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, sep } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import type { DaemonServiceTailnetChange } from "@getdomovoi/daemon"

import type { DaemonServiceOutcome, DaemonServiceStatusReport } from "./daemon-service.js"
import type { DaemonModule } from "./daemon-module.js"
import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"
import {
  parseTailnetReachRecord,
  readTailnetReachRecordText,
  savedTailnetReachEnvironment,
  tailnetHostConflict,
  tailnetName,
  tailnetReachRecordFile,
  tailnetTlsDirectory,
  type TailnetReachRecord,
} from "./tailnet-reach-record.js"
import { TailnetReach, type TailnetReachDependencies, type TailscaleRun } from "./tailnet-reach.js"

// TailnetReach (Q404 A), assembled on first use: index.ts loads this module
// with import() only when Settings first asks, so none of it counts toward the
// main process's startup bundle.

// Where a tailscale command is found when it is not on the app's PATH. A
// packaged app starts with the system's short PATH, not the login shell's.
export function tailscaleLocations(platform: NodeJS.Platform): readonly string[] {
  if (platform === "darwin") return ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
  if (platform === "win32") return ["C:\\Program Files\\Tailscale\\tailscale.exe"]
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"]
}

async function findTailscale(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, locations: readonly string[]): Promise<string | undefined> {
  const name = platform === "win32" ? "tailscale.exe" : "tailscale"
  const directories = (environment.PATH ?? environment.Path ?? "").split(delimiter).filter((directory) => isAbsolute(directory))
  for (const candidate of [...directories.map((directory) => join(directory, name)), ...locations]) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

// Runs tailscale with arguments only, never through a shell.
function tailscaleRunner(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, locations: readonly string[]): TailscaleRun {
  return async (args, timeoutMs) => {
    const command = await findTailscale(environment, platform, locations)
    if (command === undefined) return "missing"
    return new Promise((settle) => {
      execFile(command, [...args], { env: environment, timeout: timeoutMs, maxBuffer: 4 * 1_024 * 1_024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null
        settle({ code, stdout, stderr: stderr || (error && code === null ? error.message : "") })
      })
    })
  }
}

type AcquisitionSource = {
  current(): DesktopDaemonAcquisition | undefined
  stopOwned(): Promise<void>
  restart(): Promise<DesktopDaemonAcquisition>
  endHandoff(): void
}

type ServiceSource = {
  update(tailnet: DaemonServiceTailnetChange): Promise<DaemonServiceOutcome>
  status(): Promise<DaemonServiceStatusReport>
}

export function createTailnetReach(input: {
  desktopDaemon: AcquisitionSource
  daemon: Pick<DaemonModule, "readLocalServiceHandoffRefusal" | "holdServiceHandoffFence" | "readLocalTailnetStatus">
  service: () => Promise<ServiceSource>
  dataDirectory: string
  home?: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  tailscaleLocations?: readonly string[]
  // index.ts keeps these for the in-app daemon's next acquisition. They are
  // handed over whenever the record changes, before any restart.
  applySettings?: (settings: Record<string, string>) => void
  timers?: TailnetReachDependencies["timers"]
}): TailnetReach {
  const home = input.home ?? homedir()
  const environment = input.environment ?? process.env
  const platform = input.platform ?? process.platform
  // The daemon refuses a relative DOMOVOI_PROFILE_DIR and does not start, so
  // the fallback is only somewhere to report status from.
  const tlsDirectory = tailnetTlsDirectory(environment, home) ?? join(home, ".domovoi", "tls")
  const recordPath = join(input.dataDirectory, tailnetReachRecordFile)

  // The daemon this window reaches, if the switch may restart it: one this
  // app started, or the login service this app installed.
  const reached = async (): Promise<{ kind: "owned" | "service"; endpoint: { url: string; token: string } } | { refusal: string }> => {
    const endpoint = input.desktopDaemon.current()
    if (!endpoint || endpoint.kind === "refused") return { refusal: "this app is not connected to a daemon." }
    if (endpoint.kind === "owned") return { kind: "owned", endpoint }
    const status = endpoint.owner === "daemon" ? await (await input.service()).status().catch(() => undefined) : undefined
    if (status && "installed" in status && status.installed === true && status.running) return { kind: "service", endpoint }
    return { refusal: "this window reaches a daemon started outside this app, which only whoever started it can restart." }
  }

  const display = (path: string) => path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
  const swept = sweepPending(tlsDirectory)
  const reach = new TailnetReach({
    ...(input.timers ? { timers: input.timers } : {}),
    tailscale: tailscaleRunner(environment, platform, input.tailscaleLocations ?? tailscaleLocations(platform)),
    tlsDirectory,
    display,
    setAside: () => swept,
    // Codex review round 1 (P2-2): every effect first checks that tls is a
    // directory and not a link, and that the path it names is not a link, so
    // nothing is made, read, moved or deleted through one. tls is
    // <profile>/tls, so a tls that is not a link is inside the profile as the
    // daemon resolves it. A link made between the check and the effect is
    // same-user tampering with the profile, the accepted residual (Q411 A).
    files: {
      exists: async (path) => {
        await ownPath(tlsDirectory, path, display)
        return lstat(path).then(() => true, () => false)
      },
      read: async (path) => {
        await ownPath(tlsDirectory, path, display)
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          return await handle.readFile()
        } finally {
          await handle.close()
        }
      },
      privateDirectory: async (parent) => {
        await confinedTls(tlsDirectory, display)
        await mkdir(parent, { recursive: true, mode: 0o700 })
        await confinedTls(tlsDirectory, display)
        await chmod(parent, 0o700)
        const made = await mkdtemp(join(parent, ".pending-"))
        await writeFile(join(made, stagingMarker), "", { mode: 0o600, flag: "wx" })
        return made
      },
      // Codex review round 1 (P2-1): the file's bytes are flushed before it
      // is published under its new name, renamed reports the rename before
      // the flush that can still fail, and the directory it left is flushed
      // too, so a crash cannot bring the old name back.
      move: async (from, to, renamed) => {
        await ownPath(tlsDirectory, from, display)
        await ownPath(tlsDirectory, to, display)
        await flush(from)
        await publishFileDurably(from, to, renamed)
        if (dirname(from) !== dirname(to)) await flush(dirname(from), true)
      },
      restrict: async (path) => {
        await ownPath(tlsDirectory, path, display)
        await chmod(path, 0o600)
      },
      identity: async (path) => {
        await ownPath(tlsDirectory, path, display)
        return fileIdentity(path)
      },
      mark: async (path) => {
        await ownPath(tlsDirectory, path, display)
        await markFile(path)
      },
      remove: async (path) => {
        await ownPath(tlsDirectory, path, display)
        await rm(path, { force: true })
      },
      removeDirectory: async (path) => {
        await ownPath(tlsDirectory, path, display)
        await removeStaging(path)
      },
    },
    record: {
      // Codex review round 1 (P2-3): read as startup reads it, never through
      // a link, a FIFO or past 4 KiB.
      read: async () => {
        const text = readTailnetReachRecordText(recordPath)
        return text === undefined ? undefined : parseTailnetReachRecord(text, tlsDirectory)
      },
      write: async (record: TailnetReachRecord) => {
        await mkdir(input.dataDirectory, { recursive: true })
        const pending = `${recordPath}.${process.pid}.pending`
        await writeFile(pending, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        await publishFileDurably(pending, recordPath)
        input.applySettings?.(savedTailnetReachEnvironment(input.dataDirectory, environment, home))
      },
      remove: async () => {
        await rm(recordPath, { force: true })
        input.applySettings?.({})
      },
    },
    // Only the daemon inside this app reads this app's environment; a login
    // service runs the settings it saved.
    conflict: () => input.desktopDaemon.current()?.kind === "attached" ? undefined : tailnetHostConflict(environment),
    // Round 3 re-review (P3-2): with the switch off the in-app daemon starts
    // with these as set, so turning off cannot clear them.
    handSet: () => input.desktopDaemon.current()?.kind === "attached" || environment.DOMOVOI_TAILNET_ADDRESS === undefined ? undefined
      : "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it.",
    // Codex review round 1 (P2-5): tailnet.status from the daemon this window
    // reaches after a restart, so a change counts only once it serves the new
    // certificate on the tailnet.
    listener: async () => {
      const endpoint = input.desktopDaemon.current()
      if (!endpoint || endpoint.kind === "refused") return undefined
      return input.daemon.readLocalTailnetStatus({ endpoint, timeoutMs: 5_000 })
    },
    preflight: async () => {
      const daemon = await reached()
      if ("refusal" in daemon) return daemon.refusal
      try {
        return await input.daemon.readLocalServiceHandoffRefusal({ endpoint: daemon.endpoint, timeoutMs: 5_000 })
      } catch (cause) {
        return `its workspace could not be read (${cause instanceof Error ? cause.message : String(cause)}).`
      }
    },
    restart: async (change) => {
      const daemon = await reached()
      if ("refusal" in daemon) return { ok: false, message: `The daemon cannot restart now: ${daemon.refusal}` }
      if (daemon.kind === "service") {
        const outcome = await (await input.service()).update(change)
        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message }
      }
      // The same fence the login service handoff takes: no turn starts in the
      // daemon between the check and the stop.
      let fence: Awaited<ReturnType<DaemonModule["holdServiceHandoffFence"]>>
      try {
        fence = await input.daemon.holdServiceHandoffFence({ endpoint: daemon.endpoint, timeoutMs: 5_000 })
      } catch (cause) {
        return { ok: false, message: `The daemon could not be asked to hold new turns: ${cause instanceof Error ? cause.message : String(cause)}` }
      }
      if ("refusal" in fence) return { ok: false, message: `The daemon cannot restart now: ${fence.refusal}` }
      try {
        await input.desktopDaemon.stopOwned()
        const after = await input.desktopDaemon.restart()
        if (after.kind === "owned") return { ok: true }
        return { ok: false, message: after.kind === "refused" ? `The daemon did not start again: ${after.message}` : "The daemon did not start again: this window reached another daemon instead." }
      } catch (cause) {
        return { ok: false, message: `The daemon did not start again: ${cause instanceof Error ? cause.message : String(cause)}` }
      } finally {
        input.desktopDaemon.endHandoff()
        fence.release()
      }
    },
    // After a failed restart the settings are gone again, so the app's own
    // daemon starts as before. A service update has put the previous service
    // back itself; an attached daemon is not this app's to start.
    recover: async () => {
      if (input.desktopDaemon.current()?.kind === "attached") return
      await input.desktopDaemon.restart().catch(() => {})
    },
  })
  // Renewal runs while the switch is on, from whenever this module loads.
  void reach.startRenewal()
  return reach
}

// Codex review round 1 (P2-2): tls is a directory of the profile's own, not a
// link and not anything else. Missing is fine: privateDirectory makes it.
async function confinedTls(tlsDirectory: string, display: (path: string) => string): Promise<void> {
  let entry
  try {
    entry = await lstat(tlsDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (entry.isSymbolicLink()) throw new Error(`${display(tlsDirectory)} is a link. Domovoi keeps the tailnet certificate and key only in a directory of its own in the profile, never through a link.`)
  if (!entry.isDirectory()) throw new Error(`${display(tlsDirectory)} is not a directory. Domovoi keeps the tailnet certificate and key only in a directory of its own in the profile.`)
}

// tls as confinedTls has it, and path inside it no link. Missing is fine.
async function ownPath(tlsDirectory: string, path: string, display: (path: string) => string): Promise<void> {
  await confinedTls(tlsDirectory, display)
  let link = false
  try {
    link = (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (link) throw new Error(`${display(path)} is a link. Domovoi reads and writes the tailnet certificate and key only as files of their own, never through a link.`)
}

// A file's bytes, or a directory's entries, written to disk. Windows opens no
// directory to flush; publishFileDurably makes the same exception.
async function flush(path: string, directory = false): Promise<void> {
  if (directory && process.platform === "win32") return
  const handle = await open(path, directory ? constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) : "r+")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// Review of 049b1383 (P3-c): a crash while a certificate was being issued
// leaves <tls>/.pending-XXXXXX holding a private key. When the module loads no
// change is running, so every directory by that name (mkdtemp's six
// characters) inside tls that the switch marked and that holds only what it
// writes goes (Codex review round 1, P2-4). A link by that name is left alone, never
// followed, and so is anything else. A directory holding previous files a
// change could not put back stays, and is answered so the switch can say
// where it is (round 3 re-review, P3-3).
async function sweepPending(tlsDirectory: string): Promise<string | undefined> {
  let names: string[]
  try {
    // Codex review round 1 (P2-2): never through a tls that is a link.
    const entry = await lstat(tlsDirectory)
    if (entry.isSymbolicLink() || !entry.isDirectory()) return undefined
    names = await readdir(tlsDirectory)
  } catch {
    return undefined
  }
  let kept: string | undefined
  for (const name of names.filter((entry) => /^\.pending-[A-Za-z0-9]{6}$/u.test(entry))) {
    const path = join(tlsDirectory, name)
    try {
      if (!(await lstat(path)).isDirectory()) continue
      // Codex review round 1 (P2-4): only a directory the switch marked when
      // it made it, holding only what the switch writes there, is the
      // switch's. Anything else stays whole, and is not reported.
      const entries = await readdir(path)
      if (!entries.includes(stagingMarker) || !entries.every(stagingEntry)) continue
      if (entries.some((entry) => entry.startsWith("previous."))) {
        kept ??= path
        continue
      }
      await removeStaging(path)
    } catch {
      // Gone already, or not ours to remove: the next load tries again.
    }
  }
  return kept
}

// Codex review round 1 (P2-4): the switch marks each pending directory it
// makes with this empty file. A process of this user could forge it too, the
// accepted residual (Q411 A); nothing else makes it.
const stagingMarker = ".domovoi-tailnet-staging"

// What the switch writes in a pending directory: the marker, what tailscale
// cert writes for a tailnet name, and the previous files it sets aside.
function stagingEntry(entry: string): boolean {
  if (entry === stagingMarker || entry === "previous.crt" || entry === "previous.key") return true
  return /\.(?:crt|key)$/u.test(entry) && tailnetName(entry.slice(0, -4))
}

// Removes a pending directory's own entries, each a file, then the directory
// itself, which fails while anything else is in it. Never recursive, so what
// the switch did not write there stays.
async function removeStaging(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry)
    if (stagingEntry(entry) && (await lstat(path)).isFile()) await rm(path, { force: true })
  }
  await rmdir(directory)
}

// Codex review round 1 (P2-4): device, inode and modification time, read
// without following a link. The switch sets the time itself (mark), to a
// random whole second in 2000 to 2019, so a file put at the path later,
// even on a reused inode, does not carry it.
async function fileIdentity(path: string): Promise<string | undefined> {
  try {
    const found = await lstat(path, { bigint: true })
    return `${found.dev}:${found.ino}:${found.mtimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function markFile(path: string): Promise<void> {
  const seconds = randomInt(946_684_800, 1_577_836_800)
  await utimes(path, seconds, seconds)
}
