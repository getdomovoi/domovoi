import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
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
  platform?: NodeJS.Platform
  shutdownGraceMs?: number
  killGraceMs?: number
}

export type ClaudeProcess = {
  // What the SDK drives: the child's stdio, its state and its exit.
  readonly spawned: SpawnedProcess
  readonly exited: Promise<void>
  hasExited(): boolean
  kill(): void
}

// Starts Claude the way the SDK's own spawn does (spawnLocalProcess in
// @anthropic-ai/claude-agent-sdk 0.3.263): the command, arguments, directory,
// environment and abort signal exactly as the SDK built them, piped stdio, no
// console window, and stderr decoded as UTF-8 into the stderr option, which a
// custom spawn does not get from the SDK. Like the SDK's, the exit it reports
// comes once stderr has drained, so a failure carries its last line.
//
// On POSIX Claude is detached into its own process group, which the commands
// its tools run join, so one kill reaches all of them. Windows has no process
// groups and the repository has no process tree kill, so there the kill
// reaches Claude alone.
export function spawnClaudeProcess(
  options: SpawnOptions,
  stderr: (data: string) => void,
  {
    spawn: start = spawn,
    kill = (pid, signal) => process.kill(pid, signal),
    platform = process.platform,
  }: Pick<ClaudeProcessOptions, "spawn" | "kill" | "platform"> = {},
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

  let exited = false
  const exit = new Promise<void>((resolve) => {
    const finish = () => {
      exited = true
      resolve()
    }
    child.once("exit", finish)
    // A process that never started has no exit to wait for.
    child.on("error", () => {
      if (child.pid === undefined) finish()
    })
  })
  return {
    spawned: new ClaudeSpawnedProcess(child),
    exited: exit,
    hasExited: () => exited,
    kill: () => {
      const pid = child.pid
      if (exited || pid === undefined) return
      if (platform === "win32") {
        child.kill("SIGKILL")
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

// Waits for Claude to exit after its input was closed, kills it when it does
// not within the grace, and fails when it still runs after the kill grace.
export async function stopClaudeProcess(
  child: ClaudeProcess,
  {
    shutdownGraceMs = claudeShutdownGraceMs,
    killGraceMs = claudeKillGraceMs,
  }: Pick<ClaudeProcessOptions, "shutdownGraceMs" | "killGraceMs"> = {},
): Promise<void> {
  if (await settlesBefore(child.exited, shutdownGraceMs)) return
  child.kill()
  if (await settlesBefore(child.exited, killGraceMs)) return
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
