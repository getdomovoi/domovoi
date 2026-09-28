import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { vi } from "vitest"

import type { ClaudeQuery, ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./claude.js"

export const fakeClaudePid = 4_000_001

// A stand-in for the Claude CLI process. Like Claude, it exits when its stdin
// ends, unless it is made to hang, when it ignores that and every signal until
// the test calls exit. Its pid names no real process: every test that uses it
// gives the adapter a kill spy, so no signal is ever sent to that pid.
export function fakeClaudeChild({ exitsOnEof = true, pid = fakeClaudePid } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: vi.fn((_signal?: NodeJS.Signals | number): boolean => true),
  })
  const exit = (signal: NodeJS.Signals | null = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.exitCode = signal ? null : 0
    child.signalCode = signal
    child.emit("exit", child.exitCode, signal)
    child.stdout.end()
    child.stderr.end()
    child.emit("close", child.exitCode, signal)
  }
  if (exitsOnEof) child.stdin.once("finish", () => exit())
  return { child, process: child as unknown as ChildProcessWithoutNullStreams, exit }
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
