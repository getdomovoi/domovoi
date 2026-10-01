import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"

import { windowsTreeKill } from "./claude-process.js"

export type EmbeddedServer = {
  url: string
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

type SpawnServer = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
    detached: boolean
    shell: boolean
    windowsHide: true
  },
) => ChildProcess

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

// Starts `command serve` the way the provider SDKs do (opencode
// sdk/js/src/server.ts:22-100), and waits for the line that starts with
// `banner` to say where it listens. Unlike the SDKs' servers, this one can be
// stopped with confirmation (Codex review of #691, P1): on POSIX it leads its
// own process group, and a stop kills the group, an approved command or a
// tool server it started included. On Windows taskkill ends its process tree.
// A process that left the group (setsid) or the tree is beyond a stop.
export function embeddedServerCommand(
  command: string,
  banner: string,
  spawnServer: SpawnServer = spawn,
): (options: EmbeddedServerOptions) => Promise<EmbeddedServer> {
  return (options) => startEmbeddedServer(command, banner, options, spawnServer)
}

function startEmbeddedServer(
  command: string,
  banner: string,
  options: EmbeddedServerOptions,
  spawnServer: SpawnServer,
): Promise<EmbeddedServer> {
  const windows = process.platform === "win32"
  const child = spawnServer(command, ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`], {
    env: { ...process.env, ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !windows,
    // npm installs a .cmd shim on Windows, which only a shell runs. The
    // arguments are fixed and carry no secret.
    shell: windows,
    windowsHide: true,
  })
  let exited = false
  const exit = new Promise<void>((resolve) => {
    const ended = () => {
      exited = true
      resolve()
    }
    child.once("exit", ended)
    child.once("error", ended)
  })
  const stop = async (): Promise<boolean> => {
    const pid = child.pid
    if (pid === undefined) return true
    if (windows) {
      if (exited) return true
      try {
        await windowsTreeKill(pid)
      } catch {
        return false
      }
      return settlesBefore(exit, stopConfirmMs)
    }
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if (!processMissing(error)) return false
    }
    return groupGone(pid, stopConfirmMs)
  }

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
    child.stdout?.on("data", (chunk: Buffer) => {
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
        resolve({ url, close: () => void stop(), stop })
        return
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) output += chunk.toString()
    })
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`${command} server exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`} before it listened`)
    })
    child.once("error", (error: Error) => fail(`${command} server could not start: ${error.message}`))
  })
}

// The group is gone once signalling it finds no process. A process that still
// exists but cannot be signalled (another user's) counts as still there.
async function groupGone(pid: number, timeoutMs: number): Promise<boolean> {
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
