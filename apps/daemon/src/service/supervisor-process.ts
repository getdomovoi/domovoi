import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

import { OperationDeadline, OperationDeadlineExceededError } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"
import type { GuestExit, GuestLaunch } from "./guest-supervisor.js"
import { guestProcessIdentitySchema, type GuestProcessIdentity } from "./supervisor-record.js"

export function parseGuestProcessStat(text: string): { start: string; alive: boolean } {
  const end = text.lastIndexOf(") ")
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const start = fields[19]
  if (end < 0 || !start || !/^[0-9]{1,24}$/.test(start) || !/^[A-Za-z]$/.test(fields[0] ?? "")) {
    throw new Error("Guest process birth identity is unreadable")
  }
  return { start, alive: fields[0] !== "Z" && fields[0] !== "X" }
}

export function guestBootId(): string {
  return guestProcessIdentitySchema.shape.bootId.parse(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim())
}

export function guestProcessIdentity(pid: number): GuestProcessIdentity {
  const stat = parseGuestProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
  if (!stat.alive) throw new Error("Guest process exited before its birth identity could be recorded")
  return guestProcessIdentitySchema.parse({ pid, start: stat.start, bootId: guestBootId() })
}

export function guestProcessAlive(identity: GuestProcessIdentity): boolean {
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
} = {}): Promise<GuestLaunch> {
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
    let stopping: Promise<GuestExit> | undefined
    const stop = (): Promise<GuestExit> => stopping ??= (async () => {
      if (result !== undefined) return result
      child.kill("SIGTERM")
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
        void stop().then(() => reject(error), (cleanup) => reject(
          new AggregateError([error, cleanup], "Guest identity and shutdown failed", { cause: error })))
      }
    })
  })
}
