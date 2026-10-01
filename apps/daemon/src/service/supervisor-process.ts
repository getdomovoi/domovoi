import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { windowsTreeKill } from "../claude-process.js"
import { OperationDeadline, OperationDeadlineExceededError } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"
import type { GuestExit, GuestLaunch } from "./guest-supervisor.js"
import { guestProcessIdentitySchema, type GuestProcessIdentity } from "./supervisor-record.js"
import type { ServiceCommand } from "./install.js"
import { windowsPowerShellPath } from "./windows-task.js"

export function parseGuestProcessStat(text: string): { start: string; alive: boolean } {
  const end = text.lastIndexOf(") ")
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const start = fields[19]
  if (end < 0 || !start || !/^[0-9]{1,24}$/.test(start) || !/^[A-Za-z]$/.test(fields[0] ?? "")) {
    throw new Error("Guest process birth identity is unreadable")
  }
  return { start, alive: fields[0] !== "Z" && fields[0] !== "X" }
}

// Decided 2026-09-17 (SHIP-PLAN S1.1): the Windows logon task runs the same
// supervisor loop as the WSL guest, so the loop's process identities need a
// Windows reading. Windows has no /proc. A process is its pid and its creation
// time, a FILETIME in UTC that never changes and that a reused pid cannot
// share; the boot is the System process's (pid 4) creation time. Both come
// from Win32_Process through PowerShell under SystemRoot, which works without
// elevation for the user's own processes and for System.
//
// The creation time is absolute, so liveness does not depend on the boot
// reading; the boot only resolves a launch whose child was never recorded
// (supervisor-command.ts). A query that fails is a refusal, never a dead
// process.
export class ProcessExitedBeforeIdentityError extends Error {
  constructor() {
    super("The process exited before its creation time could be read")
    this.name = "ProcessExitedBeforeIdentityError"
  }
}

export type WindowsProcessAnswer = { boot: string; start: string | null }
export type WindowsProcessQuery = (pid: number) => WindowsProcessAnswer

export function windowsProcessQueryCommand(pid: number): ServiceCommand {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) throw new Error("A Windows process id must be a positive integer")
  const script = `
$ErrorActionPreference = 'Stop'
$boot = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = 4'
if ($null -eq $boot -or $null -eq $boot.CreationDate) { throw 'Windows reported no System process creation time' }
$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'
$start = if ($null -eq $process -or $null -eq $process.CreationDate) { 'missing' } else { [string]$process.CreationDate.ToFileTimeUtc() }
[Console]::Out.WriteLine('domovoi-process:' + [string]$boot.CreationDate.ToFileTimeUtc() + ':' + $start)
`
  return {
    command: windowsPowerShellPath(),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  }
}

export function parseWindowsProcessAnswer(text: string): WindowsProcessAnswer {
  const match = /^domovoi-process:([0-9]{1,24}):([0-9]{1,24}|missing)$/.exec(text.trim())
  if (!match) throw new Error("Windows did not report a process creation time")
  return { boot: match[1]!, start: match[2] === "missing" ? null : match[2]! }
}

// Synchronous, as the Linux reads are: the loop and the stop proof call these
// between their own steps. Exit 0 is the only answer; anything else throws.
export function windowsProcessQuery(pid: number): WindowsProcessAnswer {
  const { command, args } = windowsProcessQueryCommand(pid)
  return parseWindowsProcessAnswer(execFileSync(command, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }))
}

// The record keeps a boot identity in UUID form, as Linux supplies one. This
// is a SHA-256 of the System process creation time, shaped as an RFC 9562
// version 8 (custom) UUID.
export function windowsBootId(boot: string): string {
  const hex = createHash("sha256").update(`domovoi-windows-boot:${boot}`).digest("hex")
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return guestProcessIdentitySchema.shape.bootId.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`)
}

export function windowsProcessIdentity(pid: number, query: WindowsProcessQuery = windowsProcessQuery): GuestProcessIdentity {
  const answer = query(pid)
  if (answer.start === null) throw new ProcessExitedBeforeIdentityError()
  return guestProcessIdentitySchema.parse({ pid, start: answer.start, bootId: windowsBootId(answer.boot) })
}

// process.kill(pid, 0) asks Windows whether the pid still runs (libuv checks
// its exit code), so a gone process needs no PowerShell. EPERM means it runs
// as someone else; its creation time still decides whether it is this one.
function windowsPidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

export function windowsProcessAlive(identity: GuestProcessIdentity, query: WindowsProcessQuery = windowsProcessQuery, runs: (pid: number) => boolean = windowsPidRuns): boolean {
  guestProcessIdentitySchema.parse(identity)
  if (!runs(identity.pid)) return false
  return query(identity.pid).start === identity.start
}

export function guestBootId(): string {
  if (process.platform === "win32") return windowsBootId(windowsProcessQuery(process.pid).boot)
  return guestProcessIdentitySchema.shape.bootId.parse(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim())
}

export function guestProcessIdentity(pid: number): GuestProcessIdentity {
  if (process.platform === "win32") return windowsProcessIdentity(pid)
  const stat = parseGuestProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
  if (!stat.alive) throw new Error("Guest process exited before its birth identity could be recorded")
  return guestProcessIdentitySchema.parse({ pid, start: stat.start, bootId: guestBootId() })
}

export function guestProcessAlive(identity: GuestProcessIdentity): boolean {
  if (process.platform === "win32") return windowsProcessAlive(identity)
  guestProcessIdentitySchema.parse(identity)
  if (guestBootId() !== identity.bootId) return false
  try {
    const stat = parseGuestProcessStat(readFileSync(`/proc/${identity.pid}/stat`, "utf8"))
    return stat.alive && stat.start === identity.start
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
    throw error
  }
}

export function launchGuestChild(executable: string, args: string[], options: {
  identify?: (pid: number) => GuestProcessIdentity; environment?: NodeJS.ProcessEnv
  // Windows: the stop ends the child's whole process tree (taskkill /T /F),
  // since Windows has no SIGTERM and kill() would end the daemon alone,
  // leaving the agents and terminals it started.
  platform?: NodeJS.Platform; treeKill?: (pid: number) => Promise<void>
} = {}): Promise<GuestLaunch> {
  const platform = options.platform ?? process.platform
  const treeKill = options.treeKill ?? ((pid: number) => windowsTreeKill(pid))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: options.environment ?? process.env })
    let spawned = false
    let result: GuestExit | undefined
    let resolveExit: (exit: GuestExit) => void
    let rejectExit: (error: unknown) => void
    const exited = new Promise<GuestExit>((yes, no) => { resolveExit = yes; rejectExit = no })
    // The launch handshake may fail before a caller can attach its listener.
    void exited.catch(() => {})
    child.once("exit", (code, signal) => { result = { code, signal }; resolveExit(result) })
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (spawned) { rejectExit(error); return }
      if (typeof error.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(error.code)) {
        resolve({ state: "failed", errorCode: error.code })
      } else reject(new Error("Guest launch failed without a structured OS error code", { cause: error }))
    })
    const wait = async () => {
      const deadline = OperationDeadline.start(5_000)
      try { return await withinServiceDeadline(deadline, () => exited) } finally { deadline.clear() }
    }
    const terminate = async () => {
      if (platform !== "win32" || child.pid === undefined) { child.kill("SIGTERM"); return }
      // A tree kill that fails leaves the deadline below to decide; kill()
      // then ends at least the daemon itself.
      await treeKill(child.pid).catch(() => {})
    }
    let stopping: Promise<GuestExit> | undefined
    const stop = (): Promise<GuestExit> => stopping ??= (async () => {
      if (result !== undefined) return result
      await terminate()
      try { return await wait() } catch (error) {
        if (!(error instanceof OperationDeadlineExceededError)) throw error
        child.kill("SIGKILL")
        const [cleanup] = await Promise.allSettled([wait()])
        if (cleanup.status === "rejected") {
          throw new AggregateError([error, cleanup.reason], "Guest child stop could not be proved", { cause: error })
        }
        return cleanup.value
      }
    })()
    child.once("spawn", () => {
      spawned = true
      try {
        if (child.pid === undefined) throw new Error("Guest launch supplied no child pid")
        const identity = (options.identify ?? guestProcessIdentity)(child.pid)
        resolve({ state: "started", child: { identity, exited, stop } })
      } catch (error) {
        // On Windows the creation time is read after the spawn, through a
        // PowerShell that takes a moment; a daemon that exits at once is gone
        // by then. Its exit is a failed launch, counted as a crash, once it is
        // known to have ended: no child is left whose identity was not kept.
        const exitedFirst = error instanceof ProcessExitedBeforeIdentityError
        void stop().then(() => exitedFirst ? resolve({ state: "failed", errorCode: "EXITED_BEFORE_IDENTITY" }) : reject(error), (cleanup) => reject(
          new AggregateError([error, cleanup], "Guest identity and shutdown failed", { cause: error })))
      }
    })
  })
}
