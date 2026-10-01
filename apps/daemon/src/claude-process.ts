import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { win32 } from "node:path"
import type { Duplex } from "node:stream"
import { StringDecoder } from "node:string_decoder"

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

import { onProcessEnd } from "./process-end.js"

// The same grace the Codex transport gives its app-server before a kill.
export const claudeShutdownGraceMs = 2_000
// How long a killed Claude has to exit before the stop is reported as failed.
export const claudeKillGraceMs = 5_000
// How often a process group whose leader has gone is checked for members.
const groupProbeIntervalMs = 50

export type ClaudeSpawnOptions = {
  cwd?: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  // On POSIX the fourth pipe is the keeper's control pipe, and the fifth the
  // sentinel's (see claudeKeeperSource).
  stdio: ["pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe", "pipe", "pipe"]
  windowsHide: true
  detached: boolean
}

export type ClaudeSpawn = (
  command: string,
  args: string[],
  options: ClaudeSpawnOptions,
) => ChildProcessWithoutNullStreams

export type ClaudeProcessOptions = {
  spawn?: ClaudeSpawn
  // Sends signal 0 to a process group by its negative pid, as process.kill
  // does: it returns while the group has a process, even one that may not
  // be signalled, and throws ESRCH once it has none. Signal 0 is never
  // delivered, so a number that names another group by then costs only a
  // longer wait. A test passes a stub.
  probe?: (pid: number) => void
  // Kills a Windows process tree, and rejects when taskkill cannot start or
  // reports a failure. A test passes a spy.
  killTree?: (pid: number) => Promise<void>
  platform?: NodeJS.Platform
  shutdownGraceMs?: number
  killGraceMs?: number
}

export type ClaudeProcess = {
  // What the SDK drives: Claude's stdio, its state and its exit.
  readonly spawned: SpawnedProcess
  // Settles once Claude and every process it started are known to be gone:
  // on POSIX its whole process group, on Windows the tree a stop's taskkill
  // ended. A Windows Claude that exited on its own before any stop never
  // settles it: nothing then says what became of what it started.
  readonly exited: Promise<void>
  hasExited(): boolean
  // Whether Claude itself is known to have exited, whatever became of what
  // it started.
  claudeHasExited(): boolean
  kill(): Promise<void>
}

// A Claude process Domovoi started that is not known to be gone, named by its
// pid and the Claude session it runs, if any. A model list runs none. On
// POSIX the pid is the keeper's, which is also the process group's id.
export type RunningClaudeProcess = {
  readonly pid: number
  readonly session?: string
  readonly exited: Promise<void>
}

// Every Claude process this daemon started and has not seen gone, with what
// it started. A shutdown whose stop failed reads it to keep the profile until
// each one is gone.
const running = new Set<RunningClaudeProcess>()

export function runningClaudeProcesses(): RunningClaudeProcess[] {
  return [...running]
}

type TaskkillSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; windowsHide: true; shell: false; stdio: "ignore" },
) => ChildProcess

// The Windows directory when SystemRoot does not name one.
const defaultSystemRoot = "C:\\Windows"

// The system's own System32 directory (security review round 4 of #647,
// R4-F1). A bare name such as "taskkill" is looked up in the current
// directory, then along PATH, where the project or a tool can put a program
// of that name. So the directory comes from SystemRoot, and only when that is
// an absolute path on a drive: a missing, relative, drive-relative or network
// path, or one with a NUL, gives way to the default.
function windowsSystemDirectory(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot
  const usable = root !== undefined && /^[A-Za-z]:[\\/]/.test(root) && !root.includes("\0")
  return win32.join(usable ? root : defaultSystemRoot, "System32")
}

// Windows has no process groups: taskkill /T ends the process and every
// process it started, and /F does so without asking. The system's taskkill,
// run from its own directory with fixed arguments, no shell and no console
// window. It resolves once taskkill has reported success, and rejects when
// taskkill cannot start or exits with any other status: then nothing says
// that the processes Claude started have ended.
export function windowsTreeKill(
  pid: number,
  run: TaskkillSpawn = spawn,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (reason: string) => reject(new Error(`taskkill ${reason}`))
    const system = windowsSystemDirectory(environment)
    let taskkill: ChildProcess
    try {
      taskkill = run(win32.join(system, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        cwd: system, windowsHide: true, shell: false, stdio: "ignore",
      })
    } catch {
      failed("could not start")
      return
    }
    taskkill.once("error", () => failed("could not start"))
    taskkill.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolve()
      else failed(signal === null ? `exited with status ${String(code)}` : `ended by ${signal}`)
    })
  })
}

// The keeper: a small Node program that leads Claude's process group on
// POSIX (security review round 2 of #647, R2-F2). Domovoi starts it detached,
// so it is the group leader and the group's id is its pid, and it starts
// Claude inside that group, where the commands Claude's tools run join them.
//
// A process group's id cannot name another group while the group has a
// member, and the keeper is one until it dies. So the group is only ever
// killed from inside it, with kill(0), which names the caller's own group: by
// the keeper when Claude exits, whether a stop asked for it or not (Q104), and
// when Domovoi asks for the kill, and by the sentinel below once the keeper
// has gone. Domovoi never signals the group by number, which after the
// group's last process has been reaped could name another.
//
// What Claude sees is what the SDK asked for: the command, arguments and
// environment arrive on the control pipe (fd 3) and are passed to spawn as
// they are, Claude inherits the keeper's directory and its stdio, which are
// Domovoi's pipes, and fd 3 is /dev/null in Claude, so the control pipe
// reaches neither Claude nor its tools. Signals the SDK sends, and SIGTERM,
// SIGINT and SIGHUP sent to the keeper, go on to Claude. Claude's exit code
// or signal is reported back on the control pipe before the group is killed.
// The keeper's own environment is empty, so nothing in the SDK's, such as
// NODE_OPTIONS, changes how the keeper runs. If the control pipe closes,
// Domovoi has gone and nothing else can stop the group, so the keeper kills
// it. The source is plain CommonJS, run with node -e, so nothing is shipped
// or written to disk for it.
//
// The sentinel (security review round 3 of #647, R3-F2): the keeper can die
// on its own, sent SIGKILL by a tool for one, and Claude and its tools would
// then have no one to end their group, since Domovoi never signals it by
// number. So before Claude, the keeper starts a second member of the group:
// /bin/sh, with no environment, in /, whose input is Domovoi's fifth pipe
// (fd 4, closed in the keeper as soon as the sentinel has it, and /dev/null
// in Claude). It ignores HUP, INT and TERM, reads one line, and on that line,
// or on the pipe's end when Domovoi has gone, kills its own group with
// kill(0), which names the caller's group and so no other. Domovoi writes the
// line once the keeper has gone. If the sentinel has died as well, the line
// reaches no one, nothing is signalled, and the stop fails: Claude stays
// listed and the profile lease stays held until the group is seen empty. A
// keeper whose sentinel did not start does not start Claude.
export const claudeKeeperSource = `"use strict"
const { spawn } = require("node:child_process")
const { closeSync, openSync } = require("node:fs")
const { Socket } = require("node:net")
const control = new Socket({ fd: 3, readable: true, writable: true })
let sentinel
try {
  const nothing = openSync("/dev/null", "r")
  try {
    sentinel = spawn("/bin/sh", ["-c", "trap '' HUP INT TERM; read line; kill -s KILL 0"], {
      cwd: "/", env: {}, stdio: [4, "ignore", "ignore", nothing, nothing],
    })
    sentinel.on("error", () => {})
  } finally {
    closeSync(nothing)
  }
} catch {}
try { closeSync(4) } catch {}
let claude
let buffered = ""
const waiting = []
const end = () => {
  try { process.kill(0, "SIGKILL") } catch {}
  process.exit(1)
}
const report = (message) => {
  const done = setTimeout(end, 1000)
  try {
    control.write(JSON.stringify(message) + "\\n", () => { clearTimeout(done); end() })
  } catch {
    end()
  }
}
const forward = (signal) => {
  if (claude === undefined) waiting.push(signal)
  else if (claude.exitCode === null && claude.signalCode === null) {
    try { claude.kill(signal) } catch {}
  }
}
const start = ({ command, args, env }) => {
  if (sentinel === undefined || sentinel.pid === undefined || sentinel.exitCode !== null || sentinel.signalCode !== null) {
    report({ error: { message: "Domovoi could not start the process that holds Claude's process group" } })
    return
  }
  // "ignore" would leave fds 3 and 4 as they are above stdio, so /dev/null
  // replaces them.
  let nothing
  try {
    nothing = openSync("/dev/null", "r")
    claude = spawn(command, args, { env, stdio: ["inherit", "inherit", "inherit", nothing, nothing] })
  } catch (error) {
    report({ error: { message: String(error && error.message), code: error && error.code } })
    return
  } finally {
    if (nothing !== undefined) closeSync(nothing)
  }
  claude.on("error", (error) => {
    if (claude.pid !== undefined) return
    const { message, code, errno, syscall, path, spawnargs } = error
    report({ error: { message, code, errno, syscall, path, spawnargs } })
  })
  claude.once("exit", (code, signal) => report({ exit: { code, signal } }))
  for (const signal of waiting.splice(0)) forward(signal)
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => forward(signal))
process.on("uncaughtException", end)
control.setEncoding("utf8")
control.on("data", (text) => {
  buffered += text
  for (let newline = buffered.indexOf("\\n"); newline >= 0; newline = buffered.indexOf("\\n")) {
    let message
    try { message = JSON.parse(buffered.slice(0, newline)) } catch { message = {} }
    buffered = buffered.slice(newline + 1)
    if (message.spawn && claude === undefined) start(message.spawn)
    else if (typeof message.signal === "string") forward(message.signal)
    else if (message.kill === true) end()
  }
})
control.on("end", end)
control.on("error", end)
`

// Starts Claude the way the SDK's own spawn does (spawnLocalProcess in
// @anthropic-ai/claude-agent-sdk 0.3.281): the command, arguments, directory,
// environment and abort signal exactly as the SDK built them, piped stdio, no
// console window, and stderr decoded as UTF-8 into the stderr option, which a
// custom spawn does not get from the SDK. Like the SDK's, the exit it reports
// comes once stderr has drained, so a failure carries its last line.
//
// On POSIX Claude runs under the keeper (claudeKeeperSource), detached into
// its own process group, which the commands its tools run join, so one kill
// reaches all of them. On Windows Claude is started directly and the kill is
// taskkill on its process tree.
export function spawnClaudeProcess(
  options: SpawnOptions,
  stderr: (data: string) => void,
  {
    spawn: start = spawn,
    probe = (pid) => { process.kill(pid, 0) },
    killTree = windowsTreeKill,
    platform = process.platform,
  }: Pick<ClaudeProcessOptions, "spawn" | "probe" | "killTree" | "platform"> = {},
  session?: string,
): ClaudeProcess {
  const windows = platform === "win32"
  const directory = options.cwd !== undefined ? { cwd: options.cwd } : {}
  const child = windows
    ? start(options.command, options.args, {
      ...directory,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    })
    : start(process.execPath, ["-e", claudeKeeperSource], {
      ...directory,
      env: {},
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    })
  const decoder = new StringDecoder("utf8")
  child.stderr.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk)
    if (text) stderr(text)
  })
  child.stderr.once("end", () => {
    const text = decoder.end()
    if (text) stderr(text)
  })
  // A stderr read failure loses diagnostics, not the session.
  child.stderr.on("error", () => {})

  const pid = child.pid
  // Claude itself is known to have exited, or never started.
  let claudeExited = false
  // Claude and every process it started are known to be gone.
  let gone = false
  let entry: RunningClaudeProcess | undefined
  let resolveGone!: () => void
  const exited = new Promise<void>((resolve) => { resolveGone = resolve })
  const finish = () => {
    if (gone) return
    gone = true
    claudeExited = true
    if (entry) running.delete(entry)
    resolveGone()
  }
  // A process that never started has nothing to wait for.
  child.on("error", () => {
    if (child.pid !== undefined) return
    claudeExited = true
    finish()
  })

  let spawned: SpawnedProcess
  let kill: () => Promise<void>
  if (windows) {
    // Windows gets no tree kill as Claude exits: Node closes its handle to
    // Claude as it reports the exit, so the pid can name another process at
    // once, and taskkill /T finds nothing below a process that has exited. A
    // stop kills the tree first instead (Q106, see stopClaudeProcess). Once
    // that taskkill has failed, nothing can say that what Claude started has
    // ended, so Claude is never reported gone (R2-F1).
    //
    // A Claude that exits on its own, before any stop killed its tree, may
    // leave processes running all the same, and its exit says nothing of
    // them (R3-F1). Domovoi does not look for them (Q111): a process found
    // by a list is named only by its pid, which may name another process by
    // the time it is killed, and its parent pid and creation time do not
    // prove that Claude started it (security review round 4 of #647, R4-F2
    // and R4-F3). So its tree stays unconfirmed for good, as after a failed
    // taskkill: every stop of it fails, and it stays listed, which keeps a
    // daemon stop's profile lease. #655 tracks a design that can confirm it.
    let tree: "untouched" | "killing" | "killed" | "unconfirmed" = "untouched"
    const settle = () => {
      if (!claudeExited) return
      if (tree === "killed" || pid === undefined) finish()
      else if (tree === "untouched") tree = "unconfirmed"
    }
    child.once("exit", () => {
      claudeExited = true
      settle()
    })
    spawned = new ClaudeSpawnedProcess(child)
    kill = async () => {
      if (gone || claudeExited || tree !== "untouched" || pid === undefined) return
      tree = "killing"
      try {
        await killTree(pid)
        tree = "killed"
      } catch {
        tree = "unconfirmed"
      }
      // Until its exit is recorded Node holds a handle to Claude, which keeps
      // its pid from naming another process. The kill of Claude itself goes
      // through that handle, in case taskkill reached nothing.
      if (!claudeExited) child.kill("SIGKILL")
      settle()
    }
  } else {
    // The keeper kills the group as Claude exits, stopped or not (Q104), or
    // when asked. Its death is not the group's: a process that changed its
    // credentials refuses the kill, and one that was sent it may not have
    // died yet. So once the keeper has gone, the group is checked with
    // signal 0 until it has no process left (R2-F1).
    //
    // Nor is its death Claude's (R3-F2): only the keeper's report says that
    // Claude has exited, and a keeper killed on its own reports nothing.
    // Claude is then known to have exited once the group is seen empty. A
    // kill after the keeper has gone is the sentinel's (see
    // claudeKeeperSource), asked for on its pipe.
    const control = keeperControl(child)
    const sentinel = sentinelPipe(child)
    const empty = () => {
      if (pid === undefined) return true
      try {
        probe(-pid)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    }
    const check = () => {
      if (gone) return
      if (empty()) finish()
      else setTimeout(check, groupProbeIntervalMs).unref()
    }
    let keeperExited = false
    let claudeReported = false
    // Once the keeper has gone: the sentinel kills the group from inside it,
    // or, if it has gone too, nothing is signalled.
    const killGroup = () => {
      if (!gone && sentinel.writable) sentinel.write("kill\n")
    }
    child.once("exit", () => {
      keeperExited = true
      check()
    })
    spawned = new KeptClaudeProcess(child, control, exited, killGroup, () => {
      claudeReported = true
      claudeExited = true
    })
    send(control, { spawn: { command: options.command, args: options.args, env: options.env } })
    kill = async () => {
      if (gone) return
      if (keeperExited) killGroup()
      // A keeper that has reported Claude's exit kills the group itself.
      else if (!claudeReported) send(control, { kill: true })
    }
  }
  if (pid !== undefined && !gone) {
    entry = { pid, ...(session !== undefined ? { session } : {}), exited }
    running.add(entry)
  }
  return {
    spawned,
    exited,
    hasExited: () => gone,
    claudeHasExited: () => claudeExited,
    kill,
  }
}

function keeperControl(child: ChildProcessWithoutNullStreams): Duplex {
  const control = (child.stdio as unknown as Array<Duplex | null | undefined>)[3]
  if (!control) throw new Error("Claude's keeper has no control pipe")
  // A write after the keeper has gone fails; the keeper's exit says so.
  control.on("error", () => {})
  return control
}

// Domovoi's end of the sentinel's pipe. Only the sentinel holds the other end,
// so it ends as the sentinel dies. It is read to that end, which the keeper's
// close waits for, and a write after it fails and signals nothing.
function sentinelPipe(child: ChildProcessWithoutNullStreams): Duplex {
  const pipe = (child.stdio as unknown as Array<Duplex | null | undefined>)[4]
  if (!pipe) throw new Error("Claude's keeper has no pipe to its sentinel")
  pipe.on("error", () => {})
  pipe.resume()
  return pipe
}

function send(control: Duplex, message: Record<string, unknown>): void {
  if (!control.writable) return
  control.write(`${JSON.stringify(message)}\n`)
}

// Stops a running Claude. `close` closes its input and query, which asks it
// to exit.
//
// On POSIX the input closes first, and Claude has the grace to exit. When it
// exits within the grace the keeper killed its group as it exited (see
// claudeKeeperSource); otherwise the kill comes after the grace, from the
// keeper, or from the sentinel once the keeper has gone.
//
// On Windows the tree kill comes first, while Claude still runs: once Claude
// has exited on its own, taskkill /T can no longer find the processes it
// started (Q106). Claude gets no grace to flush its transcript. The input
// closes once taskkill has finished, or the kill grace has run out. A Claude
// that had already exited is not killed, and nothing it started is looked
// for (Q111, see spawnClaudeProcess).
//
// Either way the stop fails when, after the kill grace, Claude still runs or
// the processes it started are not known to be gone: a kill refused or not
// yet seen to take effect, a taskkill that failed (R2-F1), or a Windows
// Claude that exited on its own before the stop (R3-F1, Q111). The grace
// also bounds the wait for taskkill.
export async function stopClaudeProcess(
  child: ClaudeProcess,
  close: () => void,
  {
    platform = process.platform,
    shutdownGraceMs = claudeShutdownGraceMs,
    killGraceMs = claudeKillGraceMs,
  }: Pick<ClaudeProcessOptions, "platform" | "shutdownGraceMs" | "killGraceMs"> = {},
): Promise<void> {
  let killed: Promise<void>
  if (platform === "win32") {
    killed = child.kill().catch(() => {})
    void settlesBefore(killed, killGraceMs).then(close)
  } else {
    close()
    if (await settlesBefore(child.exited, shutdownGraceMs)) return
    killed = child.kill().catch(() => {})
  }
  if (await settlesBefore(Promise.all([child.exited, killed]).then(() => {}), killGraceMs)) return
  if (child.hasExited()) return
  throw new Error(child.claudeHasExited()
    ? "Claude Code exited, but Domovoi could not confirm that every process it started has exited"
    : "Claude Code did not exit after Domovoi stopped it")
}

class ClaudeSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: ChildProcessWithoutNullStreams["stdin"]
  readonly stdout: ChildProcessWithoutNullStreams["stdout"]
  readonly #child: ChildProcessWithoutNullStreams

  constructor(child: ChildProcessWithoutNullStreams) {
    super()
    this.#child = child
    this.stdin = child.stdin
    this.stdout = child.stdout
    onProcessEnd(child, (code, signal) => this.emit("exit", code, signal))
    child.on("error", (error) => {
      if (this.listenerCount("error") > 0) this.emit("error", error)
    })
  }

  get killed(): boolean { return this.#child.killed }
  get exitCode(): number | null { return this.#child.exitCode }
  get signalCode(): NodeJS.Signals | null { return this.#child.signalCode }

  kill(signal: NodeJS.Signals): boolean {
    return this.#child.kill(signal)
  }
}

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null }

type SpawnErrorDetails = { code?: string; errno?: number; syscall?: string; path?: string; spawnargs?: string[] }

type KeeperReport = {
  exit?: ExitStatus
  error?: SpawnErrorDetails & { message?: string }
}

// One line the keeper wrote, or nothing when it is not a report.
function keeperReport(line: string): KeeperReport | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { exit, error } = value as Record<string, unknown>
  if (typeof exit === "object" && exit !== null) {
    const { code, signal } = exit as Record<string, unknown>
    return {
      exit: {
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal as NodeJS.Signals : null,
      },
    }
  }
  if (typeof error === "object" && error !== null) {
    const { message, code, errno, syscall, path, spawnargs } = error as Record<string, unknown>
    return {
      error: {
        ...(typeof message === "string" ? { message } : {}),
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof errno === "number" ? { errno } : {}),
        ...(typeof syscall === "string" ? { syscall } : {}),
        ...(typeof path === "string" ? { path } : {}),
        ...(Array.isArray(spawnargs) && spawnargs.every((arg) => typeof arg === "string") ? { spawnargs: spawnargs as string[] } : {}),
      },
    }
  }
  return undefined
}

// Claude under the keeper, as the SDK sees it: Claude's own stdio, which are
// the keeper's pipes, Claude's exit code or signal, and signals sent to
// Claude. The exit is reported once the keeper has gone, so after the kill
// of Claude's group, and once stdio has drained, as the SDK's own spawn
// reports it. A keeper that has gone without reporting Claude's exit, killed
// on its own or by Domovoi's kill, says nothing of Claude, which may still
// run and answer the SDK: its exit is reported once the group is seen empty
// (R3-F2). A spawn error the keeper reports is raised as the error Node would
// have raised to Domovoi.
class KeptClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: ChildProcessWithoutNullStreams["stdin"]
  readonly stdout: ChildProcessWithoutNullStreams["stdout"]
  readonly #keeper: ChildProcessWithoutNullStreams
  readonly #control: Duplex
  readonly #killGroup: () => void
  #groupGone = false
  #reported: ExitStatus | undefined
  #status: ExitStatus | undefined
  #killed = false

  constructor(
    keeper: ChildProcessWithoutNullStreams,
    control: Duplex,
    groupGone: Promise<void>,
    killGroup: () => void,
    claudeExited: () => void,
  ) {
    super()
    this.#keeper = keeper
    this.#control = control
    this.#killGroup = killGroup
    this.stdin = keeper.stdin
    this.stdout = keeper.stdout

    // Claude's exit is known once the keeper has exited and its report has
    // been read, which the end of the control pipe says, or, with no report,
    // once the group is seen empty.
    const ends = new EventEmitter()
    let keeperExit: ExitStatus | undefined
    let keeperClosed = false
    let controlEnded = false
    let exitSent = false
    let closeSent = false
    const status = (): ExitStatus => this.#reported ?? keeperExit ?? { code: keeper.exitCode, signal: keeper.signalCode }
    const update = () => {
      if (!controlEnded) return
      if (this.#reported === undefined && !this.#groupGone) return
      if (keeperExit && !exitSent) {
        exitSent = true
        const { code, signal } = status()
        ends.emit("exit", code, signal)
      }
      if (keeperClosed && !closeSent) {
        closeSent = true
        const { code, signal } = status()
        ends.emit("close", code, signal)
      }
    }
    keeper.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      keeperExit = { code, signal }
      update()
    })
    keeper.once("close", () => {
      keeperClosed = true
      update()
    })
    const controlEnd = () => {
      controlEnded = true
      update()
    }
    control.once("end", controlEnd)
    control.once("close", controlEnd)
    control.once("error", controlEnd)
    void groupGone.then(() => {
      this.#groupGone = true
      update()
    })

    let buffered = ""
    control.setEncoding("utf8")
    control.on("data", (text: string) => {
      buffered += text
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const report = keeperReport(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        if (report === undefined || this.#reported !== undefined) continue
        if (report.exit) {
          this.#reported = { code: report.exit.code, signal: report.exit.signal }
          claudeExited()
        } else if (report.error) {
          const { message, ...details } = report.error
          this.#reported = { code: typeof details.errno === "number" ? details.errno : null, signal: null }
          claudeExited()
          if (this.listenerCount("error") > 0) this.emit("error", Object.assign(new Error(message ?? "Claude Code could not start"), details))
        }
      }
    })

    onProcessEnd(ends, (code, signal) => {
      this.#status = { code, signal }
      this.emit("exit", code, signal)
    })
    // The keeper's own start failed, or the SDK aborted it.
    keeper.on("error", (error) => {
      if (this.listenerCount("error") > 0) this.emit("error", error)
    })
  }

  get killed(): boolean { return this.#killed }
  get exitCode(): number | null { return this.#status?.code ?? null }
  get signalCode(): NodeJS.Signals | null { return this.#status?.signal ?? null }

  // The keeper sends the signal on to Claude. Once the keeper has gone
  // without a report, nothing can signal Claude alone, whose pid Domovoi
  // does not hold, but a SIGKILL may still end it with its whole group,
  // through the sentinel.
  kill(signal: NodeJS.Signals): boolean {
    if (this.#reported !== undefined || this.#groupGone) return false
    if (this.#keeper.exitCode !== null || this.#keeper.signalCode !== null) {
      if (signal !== "SIGKILL") return false
      this.#killGroup()
      this.#killed = true
      return true
    }
    if (!this.#control.writable) return false
    send(this.#control, { signal })
    this.#killed = true
    return true
  }
}

function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
