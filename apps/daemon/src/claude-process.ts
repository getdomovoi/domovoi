import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { StringDecoder } from "node:string_decoder"

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

import { onProcessEnd } from "./process-end.js"

// The same grace the Codex transport gives its app-server before a kill.
export const claudeShutdownGraceMs = 2_000
// How long a killed Claude has to exit before the stop is reported as failed.
export const claudeKillGraceMs = 5_000

export type ClaudeSpawnOptions = {
  cwd?: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  stdio: ["pipe", "pipe", "pipe"]
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
  // Signals a process group by its negative pid. A test passes a spy.
  kill?: (pid: number, signal: NodeJS.Signals) => void
  // Kills a Windows process tree and settles once that is done. A test
  // passes a spy.
  killTree?: (pid: number) => Promise<void>
  platform?: NodeJS.Platform
  shutdownGraceMs?: number
  killGraceMs?: number
}

export type ClaudeProcess = {
  // What the SDK drives: the child's stdio, its state and its exit.
  readonly spawned: SpawnedProcess
  readonly exited: Promise<void>
  hasExited(): boolean
  kill(): Promise<void>
}

// A Claude process Domovoi started that has not exited yet, named by its pid
// and the Claude session it runs, if any. A model list runs none.
export type RunningClaudeProcess = {
  readonly pid: number
  readonly session?: string
  readonly exited: Promise<void>
}

// Every Claude process this daemon started and has not seen exit. A shutdown
// whose stop failed reads it to keep the profile until each one has exited.
const running = new Set<RunningClaudeProcess>()

export function runningClaudeProcesses(): RunningClaudeProcess[] {
  return [...running]
}

type TaskkillSpawn = (
  command: "taskkill",
  args: string[],
  options: { windowsHide: true; shell: false; stdio: "ignore" },
) => ChildProcess

// Windows has no process groups: taskkill /T ends the process and every
// process it started, and /F does so without asking. Fixed arguments, no
// shell and no console window. It settles once taskkill has finished, or has
// failed to start; the exit of the process it was asked to kill, not this,
// decides whether a stop succeeded.
export function windowsTreeKill(pid: number, run: TaskkillSpawn = spawn): Promise<void> {
  return new Promise((resolve) => {
    let taskkill: ChildProcess
    try {
      taskkill = run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" })
    } catch {
      resolve()
      return
    }
    taskkill.once("error", () => resolve())
    taskkill.once("exit", () => resolve())
  })
}

// Starts Claude the way the SDK's own spawn does (spawnLocalProcess in
// @anthropic-ai/claude-agent-sdk 0.3.263): the command, arguments, directory,
// environment and abort signal exactly as the SDK built them, piped stdio, no
// console window, and stderr decoded as UTF-8 into the stderr option, which a
// custom spawn does not get from the SDK. Like the SDK's, the exit it reports
// comes once stderr has drained, so a failure carries its last line.
//
// On POSIX Claude is detached into its own process group, which the commands
// its tools run join, so one kill reaches all of them. On Windows the kill is
// taskkill on Claude's process tree.
export function spawnClaudeProcess(
  options: SpawnOptions,
  stderr: (data: string) => void,
  {
    spawn: start = spawn,
    kill = (pid, signal) => process.kill(pid, signal),
    killTree = windowsTreeKill,
    platform = process.platform,
  }: Pick<ClaudeProcessOptions, "spawn" | "kill" | "killTree" | "platform"> = {},
  session?: string,
): ClaudeProcess {
  const child = start(options.command, options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: platform !== "win32",
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
  let exited = false
  let entry: RunningClaudeProcess | undefined
  const exit = new Promise<void>((resolve) => {
    const finish = () => {
      if (exited) return
      exited = true
      if (entry) running.delete(entry)
      resolve()
    }
    child.once("exit", () => {
      // Whatever Claude leaves in its process group dies with it, so nothing
      // a session started outlives its Claude, stopped or not (Q104).
      //
      // A group id can be signalled only while it still names this group.
      // POSIX does not reuse a pid while its process is unreaped, nor while a
      // process group with that id has a member. Node reaps Claude and runs
      // this callback in the same turn, with no other JavaScript between, and
      // nothing signals the group after it: kill() does nothing once the exit
      // is recorded. So either a member still lives and the id is reserved,
      // or the group is empty and its id has been free only since Claude was
      // reaped, microseconds ago; pids are handed out in increasing order and
      // wrap at the system maximum, so reuse in that window would need the
      // whole range to cycle.
      //
      // Windows gets no tree kill here. Node closes its handle to Claude as
      // it reports the exit, so the pid can name another process at once, and
      // taskkill /T finds nothing below a process that has exited. A stop
      // kills the tree first instead (see stopClaudeProcess).
      if (platform !== "win32" && pid !== undefined) {
        try {
          kill(-pid, "SIGKILL")
        } catch {
          // The group is empty.
        }
      }
      finish()
    })
    // A process that never started has no exit to wait for.
    child.on("error", () => {
      if (child.pid === undefined) finish()
    })
  })
  if (pid !== undefined && !exited) {
    entry = { pid, ...(session !== undefined ? { session } : {}), exited: exit }
    running.add(entry)
  }
  return {
    spawned: new ClaudeSpawnedProcess(child),
    exited: exit,
    hasExited: () => exited,
    kill: async () => {
      if (exited || pid === undefined) return
      if (platform === "win32") {
        // Until its exit is recorded Node holds a handle to Claude, which
        // keeps its pid from naming another process. The kill of Claude
        // itself goes through that handle, in case taskkill reached nothing.
        await killTree(pid)
        if (!exited) child.kill("SIGKILL")
        return
      }
      try {
        kill(-pid, "SIGKILL")
      } catch {
        // The group is gone, or cannot be signalled: kill Claude itself. The
        // exit, not this call, decides whether the stop succeeded.
        child.kill("SIGKILL")
      }
    },
  }
}

// Stops a running Claude. `close` closes its input and query, which asks it
// to exit.
//
// On POSIX the input closes first, and Claude has the grace to exit. When it
// exits within the grace its group was killed as it exited (see
// spawnClaudeProcess); otherwise the kill comes after the grace.
//
// On Windows the tree kill comes first, while Claude still runs: once Claude
// has exited on its own, taskkill /T can no longer find the processes it
// started (Q106). Claude gets no grace to flush its transcript. The input
// closes once taskkill has finished, or the kill grace has run out.
//
// Either way the stop fails when Claude still runs after the kill grace,
// which also bounds the wait for taskkill.
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
  throw new Error("Claude Code did not exit after Domovoi stopped it")
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
