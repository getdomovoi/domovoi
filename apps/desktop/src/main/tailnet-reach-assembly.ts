import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve, sep } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import type { DaemonServiceTailnetChange } from "@getdomovoi/daemon"

import type { DaemonServiceOutcome, DaemonServiceStatusReport } from "./daemon-service.js"
import type { DaemonModule } from "./daemon-module.js"
import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"
import { parseTailnetReachRecord, tailnetReachRecordFile, type TailnetReachRecord } from "./tailnet-reach-record.js"
import { TailnetReach, type TailscaleRun } from "./tailnet-reach.js"

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
  daemon: Pick<DaemonModule, "readLocalServiceHandoffRefusal" | "holdServiceHandoffFence">
  service: () => Promise<ServiceSource>
  dataDirectory: string
  home?: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  tailscaleLocations?: readonly string[]
}): TailnetReach {
  const home = input.home ?? homedir()
  const environment = input.environment ?? process.env
  const platform = input.platform ?? process.platform
  const profile = environment.DOMOVOI_PROFILE_DIR === undefined ? join(home, ".domovoi") : resolve(home, environment.DOMOVOI_PROFILE_DIR)
  const tlsDirectory = join(profile, "tls")
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

  return new TailnetReach({
    tailscale: tailscaleRunner(environment, platform, input.tailscaleLocations ?? tailscaleLocations(platform)),
    tlsDirectory,
    display: (path) => path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path,
    files: {
      exists: async (path) => access(path).then(() => true, () => false),
      read: (path) => readFile(path),
      privateDirectory: async (parent) => {
        await mkdir(parent, { recursive: true, mode: 0o700 })
        await chmod(parent, 0o700)
        return mkdtemp(join(parent, ".pending-"))
      },
      move: (from, to) => publishFileDurably(from, to),
      restrict: (path) => chmod(path, 0o600),
      remove: (path) => rm(path, { force: true }),
      removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    },
    record: {
      read: async () => {
        try {
          return parseTailnetReachRecord(await readFile(recordPath, "utf8"))
        } catch {
          return undefined
        }
      },
      write: async (record: TailnetReachRecord) => {
        await mkdir(input.dataDirectory, { recursive: true })
        const pending = `${recordPath}.${process.pid}.pending`
        await writeFile(pending, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        await publishFileDurably(pending, recordPath)
      },
      remove: () => rm(recordPath, { force: true }),
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
}
