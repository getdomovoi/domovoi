import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { Duplex, PassThrough } from "node:stream"

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { vi } from "vitest"

import type { ClaudeQuery, ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./claude.js"

// Above the highest pid Linux can hand out (2^22) and macOS's (99,999), so
// this pid names no real process, and signal 0 to its group finds nothing.
export const fakeClaudePid = 4_194_305

// The keeper's control pipe, seen from Domovoi: each line Domovoi writes is
// parsed into `commands`; what the keeper reports is pushed to be read.
class FakeControl extends Duplex {
  #buffered = ""

  constructor(readonly received: (command: Record<string, unknown>) => void) {
    super()
  }

  override _read(): void {}

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#buffered += String(chunk)
    for (let newline = this.#buffered.indexOf("\n"); newline >= 0; newline = this.#buffered.indexOf("\n")) {
      this.received(JSON.parse(this.#buffered.slice(0, newline)) as Record<string, unknown>)
      this.#buffered = this.#buffered.slice(newline + 1)
    }
    callback()
  }
}

// A stand-in for the Claude CLI process. Like Claude, it exits when its stdin
// ends, unless it is made to hang, when it ignores that and every signal until
// the test calls exit; `killable` makes the group kill end it. On POSIX it also
// stands in for the keeper that leads Claude's process group: it records what
// Domovoi sends on the control pipe, and at exit reports Claude's exit there.
// Its exitCode and signalCode are Claude's.
export function fakeClaudeChild({ exitsOnEof = true, pid = fakeClaudePid, killable = false } = {}) {
  const commands: Array<Record<string, unknown>> = []
  const control = new FakeControl((command) => {
    commands.push(command)
    if (killable && command.kill === true) setImmediate(() => exit("SIGKILL"))
  })
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, control] as const,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: vi.fn((_signal?: NodeJS.Signals | number): boolean => true),
  })
  const exit = (signal: NodeJS.Signals | null = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.exitCode = signal ? null : 0
    child.signalCode = signal
    control.push(`${JSON.stringify({ exit: { code: child.exitCode, signal } })}\n`)
    control.push(null)
    child.emit("exit", child.exitCode, signal)
    child.stdout.end()
    child.stderr.end()
    child.emit("close", child.exitCode, signal)
  }
  if (exitsOnEof) child.stdin.once("finish", () => exit())
  return { child, process: child as unknown as ChildProcessWithoutNullStreams, exit, commands }
}

export function claudeSpawnOptions(
  options: ClaudeQueryOptions,
  command: string,
  args: string[],
): SpawnOptions {
  return {
    command,
    args,
    env: { PATH: "/usr/bin" },
    signal: new AbortController().signal,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }
}

// A query double that starts its process through the spawn option the adapter
// passes, as the SDK does, and whose close ends that process's stdin, as the
// SDK's close does.
export class FakeClaudeQuery implements ClaudeQuery {
  readonly interrupt = vi.fn(async (): Promise<unknown> => undefined)
  readonly close = vi.fn(() => {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
    this.process?.stdin.end()
  })
  #ended = false
  #waiters: Array<(result: IteratorResult<ClaudeSdkMessage>) => void> = []

  constructor(readonly process: SpawnedProcess | undefined) {}

  async initializationResult(): Promise<unknown> { return {} }
  async supportedModels(): Promise<unknown> {
    return [{
      value: "sonnet",
      displayName: "Sonnet 5",
      description: "Balanced coding model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
    }]
  }
  async getContextUsage(): Promise<unknown> { return {} }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => this.#ended
        ? Promise.resolve({ value: undefined, done: true })
        : new Promise((resolve) => this.#waiters.push(resolve)),
    }
  }
}

export function spawningClaudeFactory(
  command = "/opt/claude/bin/claude",
  args: string[] = ["--output-format", "stream-json"],
) {
  const calls: Array<{ options: ClaudeQueryOptions; query: FakeClaudeQuery }> = []
  const factory: ClaudeQueryFactory = (_input, options) => {
    const process = options.spawnClaudeCodeProcess?.(claudeSpawnOptions(options, command, args))
    const query = new FakeClaudeQuery(process)
    calls.push({ options, query })
    return query
  }
  // A model list opens a query too; a session query names its conversation.
  const sessions = () => calls
    .filter(({ options }) => options.sessionId !== undefined || options.resume !== undefined)
    .map(({ query }) => query)
  return { calls, factory, sessions }
}
