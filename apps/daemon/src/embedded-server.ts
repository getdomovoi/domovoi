import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { Duplex, Readable } from "node:stream"

import { claudeKeeperSource, windowsTreeKill } from "./claude-process.js"

export type EmbeddedServer = {
  url: string
  /**
   * The id a person can use to find the server's processes: its process group
   * on POSIX, its process tree's root on Windows.
   */
  processGroup?: number
  /** What processGroup names: a POSIX process group, or a Windows process tree. */
  processKind?: "group" | "tree"
  /** Starts a stop and does not wait for it. */
  close(): void
  /**
   * Ends the server and every process it started. Resolves true once none of
   * them is left, and false when that cannot be confirmed.
   */
  stop(): Promise<boolean>
}

export type EmbeddedServerOptions = {
  hostname: string
  port: number
  timeout: number
  // Added to the daemon's environment for the server process only.
  environment: Readonly<Record<string, string>>
}

type EmbeddedClientOptions = {
  baseUrl: string
  headers: Record<string, string>
}

// How long a stop waits to see the server's processes gone.
const stopConfirmMs = 5_000
const groupProbeIntervalMs = 50

// The provider servers read their password only from their environment
// (opencode server/auth.ts:18, kilo server/auth.ts:18). It is given to the
// server process alone: the daemon's own environment never holds it, and the
// arguments, which any process can list, carry none.
export async function createAuthenticatedEmbeddedRuntime<TClient>({
  passwordEnvironment,
  usernameEnvironment,
  username,
  environment = {},
  createPassword = () => randomBytes(32).toString("base64url"),
  startServer,
  createClient,
}: {
  passwordEnvironment: string
  usernameEnvironment: string
  username: string
  environment?: Readonly<Record<string, string>>
  createPassword?: () => string
  startServer: (options: EmbeddedServerOptions) => Promise<EmbeddedServer>
  createClient: (options: EmbeddedClientOptions) => TClient
}): Promise<{ client: TClient; server: EmbeddedServer }> {
  const password = createPassword()
  const server = await startServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 10_000,
    environment: {
      ...environment,
      [passwordEnvironment]: password,
      [usernameEnvironment]: username,
    },
  })
  try {
    const authorization = Buffer.from(`${username}:${password}`).toString("base64")
    const client = createClient({
      baseUrl: server.url,
      headers: { authorization: `Basic ${authorization}` },
    })
    return { client, server }
  } catch (error) {
    server.close()
    throw error
  }
}

// A started server process, however it is held.
type Launched = {
  stdout: Readable | null
  stderr: Readable | null
  processGroup: number | undefined
  processKind: "group" | "tree"
  stop(): Promise<boolean>
  // Settles, with how it ended, once the server has exited or could not start.
  ended: Promise<string>
}

// Starts `command serve` the way the provider SDKs do (opencode
// sdk/js/src/server.ts:22-100), and waits for the line that starts with
// `banner` to say where it listens. Unlike the SDKs' servers, this one can be
// stopped with confirmation (Codex review of #691, P1). On POSIX it runs under
// a keeper that leads its process group (launchKept); on Windows taskkill
// ends its process tree. A process that left the group (setsid) or the tree is
// beyond a stop.
export function embeddedServerCommand(
  command: string,
  banner: string,
  windows: WindowsLaunch = {},
): (options: EmbeddedServerOptions) => Promise<EmbeddedServer> {
  return (options) => startEmbeddedServer(command, banner, options, windows)
}

// What starts and ends a server on Windows. Tests give their own, so the
// Windows path runs on any machine without starting a real server.
export type WindowsLaunch = {
  platform?: NodeJS.Platform
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  killTree?: (pid: number) => Promise<void>
}

function startEmbeddedServer(
  command: string,
  banner: string,
  options: EmbeddedServerOptions,
  windows: WindowsLaunch,
): Promise<EmbeddedServer> {
  const args = ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`]
  const env = { ...process.env, ...options.environment }
  const launched = (windows.platform ?? process.platform) === "win32"
    ? launchDirect(command, args, env, windows)
    : launchKept(command, args, env)
  const { stop } = launched

  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stop()
      reject(new Error(output.trim() ? `${message}\nServer output: ${output.trim()}` : message))
    }
    const timer = setTimeout(
      () => fail(`${command} server did not start listening within ${options.timeout} ms`),
      options.timeout,
    )
    launched.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return
      output += chunk.toString()
      for (const line of output.split("\n")) {
        if (!line.startsWith(banner)) continue
        const url = /on\s+(https?:\/\/\S+)/u.exec(line)?.[1]
        if (!url) {
          fail(`${command} server reported an address Domovoi could not read: ${line}`)
          return
        }
        settled = true
        clearTimeout(timer)
        resolve({
          url,
          ...(launched.processGroup !== undefined
            ? { processGroup: launched.processGroup, processKind: launched.processKind }
            : {}),
          close: () => void stop(),
          stop,
        })
        return
      }
    })
    launched.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) output += chunk.toString()
    })
    void launched.ended.then((how) => fail(`${command} server ${how} before it listened`))
  })
}

// POSIX: the server runs under the keeper Domovoi holds Claude's process group
// with (claudeKeeperSource, Q108; Codex review of #691, round 2). The keeper
// leads the group and starts the server inside it, so the group's id stays
// reserved while the keeper lives, and the group is only ever killed from
// inside it with kill(0): by the keeper when the server exits, whether a stop
// asked for that or not, or when Domovoi asks; and by the keeper's sentinel
// once the keeper has gone. Domovoi never sends the group a signal by its id,
// which once the group is empty could name another. It only checks, with
// signal 0, whether any process is left. The server inherits the keeper's
// stdio, which are Domovoi's pipes, and gets the environment and arguments
// Domovoi sends on the keeper's control pipe; the keeper's own is empty.
function launchKept(command: string, args: string[], env: NodeJS.ProcessEnv): Launched {
  const keeper = spawn(process.execPath, ["-e", claudeKeeperSource], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  })
  const pid = keeper.pid
  const pipes = keeper.stdio as unknown as Array<Duplex | null | undefined>
  const control = pipes[3]
  const sentinel = pipes[4]
  control?.on("error", () => {})
  sentinel?.on("error", () => {})
  sentinel?.resume()
  let keeperExited = pid === undefined
  const keeperExit = new Promise<void>((resolve) => {
    if (keeperExited) resolve()
    keeper.once("exit", () => {
      keeperExited = true
      resolve()
    })
  })
  keeper.on("error", () => {})
  let how = "ended when the process that holds its process group ended"
  let buffered = ""
  control?.setEncoding("utf8")
  control?.on("data", (text: string) => {
    buffered += text
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      how = keeperReport(buffered.slice(0, newline)) ?? how
      buffered = buffered.slice(newline + 1)
    }
  })
  if (control?.writable) control.write(`${JSON.stringify({ spawn: { command, args, env } })}\n`)
  // Once every pipe has closed, the server's last output has arrived too.
  const ended = new Promise<string>((resolve) => keeper.once("close", () => resolve(how)))

  let gone = false
  const stop = async (): Promise<boolean> => {
    if (gone || pid === undefined) return true
    if (!keeperExited) {
      if (control?.writable) control.write(`${JSON.stringify({ kill: true })}\n`)
    } else if (sentinel?.writable) {
      sentinel.write("kill\n")
    }
    if (!await settlesBefore(keeperExit, stopConfirmMs)) return false
    if (!await groupEmpty(pid, stopConfirmMs)) return false
    gone = true
    return true
  }
  return { stdout: keeper.stdout, stderr: keeper.stderr, processGroup: pid, processKind: "group", stop, ended }
}

// How the server ended, from one line the keeper wrote: {"exit":{code,signal}}
// or {"error":{message}}. Anything else says nothing.
function keeperReport(line: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const report = parsed as Record<string, unknown>
  const exit = typeof report.exit === "object" && report.exit !== null ? report.exit as Record<string, unknown> : undefined
  if (exit) return typeof exit.code === "number" ? `exited with code ${exit.code}` : `exited with signal ${String(exit.signal)}`
  const error = typeof report.error === "object" && report.error !== null ? report.error as Record<string, unknown> : undefined
  if (!error) return undefined
  // The keeper is shared with Claude, and names Claude in the one failure it
  // reports on its own.
  const message = typeof error.message === "string" ? error.message : "the keeper gave no reason"
  return `could not start: ${message.replace("Claude's process group", "its process group")}`
}

// Windows has no process groups: the server is started directly, through a
// shell because npm installs a .cmd shim, and a stop is taskkill /T on its
// tree. The arguments are fixed and carry no secret.
//
// The root's exit says nothing of its tree: a process the server started can
// outlive it, and taskkill /T finds nothing below a root that has exited, whose
// pid may by then name another process. So the tree is tracked apart from the
// root, as for Claude (spawnClaudeProcess, Q111 B; Codex review of #691,
// round 3, Q266). A stop is confirmed only by a taskkill that succeeded while
// the root ran, followed by the root's exit. A root that exits before that,
// on its own or after a taskkill that failed, leaves its tree unconfirmed for
// good: every later stop fails, and the stopped server keeps blocking the next
// one. A taskkill that failed while the root still runs is tried again by the
// next stop, through the pid Node still holds.
function launchDirect(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  { spawn: start = spawn, killTree = windowsTreeKill }: WindowsLaunch,
): Launched {
  const child = start(command, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true })
  let tree: "running" | "killing" | "killed" | "unconfirmed" = "running"
  let killing: Promise<void> | undefined
  const ended = new Promise<string>((resolve) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (tree === "running") tree = "unconfirmed"
      resolve(code === null ? `exited with signal ${String(signal)}` : `exited with code ${code}`)
    })
    // Only a process that never started ends with an error.
    child.once("error", (error: Error) => {
      if (child.pid === undefined) resolve(`could not start: ${error.message}`)
    })
  })
  let rootExited = false
  void ended.then(() => { rootExited = true })
  const stop = async (): Promise<boolean> => {
    const pid = child.pid
    if (pid === undefined) return true
    if (tree === "running") {
      tree = "killing"
      killing = killTree(pid).then(
        () => { tree = "killed" },
        () => { tree = rootExited ? "unconfirmed" : "running" },
      )
    }
    if (killing) await killing
    if (tree !== "killed") return false
    return settlesBefore(ended.then(() => {}), stopConfirmMs)
  }
  return { stdout: child.stdout, stderr: child.stderr, processGroup: child.pid, processKind: "tree", stop, ended }
}

// The group is empty once signal 0 finds no process in it. A process that
// still exists but cannot be signalled (another user's) counts as still there.
async function groupEmpty(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (processMissing(error)) return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, groupProbeIntervalMs))
  }
}

function processMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH"
}

function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
