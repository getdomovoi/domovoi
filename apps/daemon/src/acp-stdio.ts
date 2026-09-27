import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

import { buildVersion } from "@getdomovoi/protocol"

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type Client,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"

import { AcpSessionNotOpenedError } from "./acp.js"
import type {
  AcpConfigOption,
  AcpPeer,
  AcpPeerHandlers,
  AcpPermissionRequest,
  AcpSessionSetup,
  AcpUpdate,
} from "./acp.js"
import type { AcpProviderDefinition } from "./acp-providers.js"
import { repositoryFileFrom, repositoryRootOf } from "./codex-repository-config.js"
import { onProcessEnd } from "./process-end.js"

type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams
const ACP_CLOSE_GRACE_MS = 1_000
const ACP_FORCE_CLOSE_MS = 1_000
const STDERR_TAIL_BYTES = 16_384

export class StdioAcpPeer implements AcpPeer {
  readonly #definition: AcpProviderDefinition
  readonly #handlers: AcpPeerHandlers
  readonly #spawn: ProcessSpawner
  readonly #launchRoot: string
  readonly #daemonDirectory: string
  #process: ChildProcessWithoutNullStreams | undefined
  #directory: string | undefined
  #connection: ClientSideConnection | undefined
  #capabilities: AgentCapabilities | undefined
  #closing = false

  constructor(input: {
    definition: AcpProviderDefinition
    handlers: AcpPeerHandlers
    // A private folder outside any repository; each agent process starts in a
    // new empty folder inside it.
    launchRoot: string
    // The daemon's own working directory, whose checkout the agent must not
    // inherit through its environment.
    daemonDirectory?: string
    spawnProcess?: ProcessSpawner
  }) {
    this.#definition = input.definition
    this.#handlers = input.handlers
    this.#launchRoot = input.launchRoot
    this.#daemonDirectory = input.daemonDirectory ?? process.cwd()
    this.#spawn = input.spawnProcess ?? spawnAcpProcess
  }

  async initialize(): Promise<void> {
    this.#closing = false
    const process = await this.#spawnFirstAvailable()
    if (this.#closing) {
      await terminateProcess(process)
      throw new Error(`${this.#definition.id} ACP peer was closed during initialization`)
    }
    this.#process = process
    const stderrTail = captureStderrTail(process.stderr)
    let disconnected = false
    process.once("exit", () => {
      if (this.#process !== process) return
      this.#process = undefined
      this.#connection = undefined
      this.#capabilities = undefined
      disconnected = !this.#closing
    })
    onProcessEnd(process, (code, signal) => {
      if (disconnected) this.#handlers.onDisconnect(exitReason(this.#definition.id, code, signal, stderrTail()))
    })
    try {
      const stream = ndJsonStream(
        Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
      )
      const client: Client = {
        requestPermission: (request) => this.#requestPermission(request),
        sessionUpdate: (notification) => this.#sessionUpdate(notification),
      }
      this.#connection = new ClientSideConnection(() => client, stream)
      const initialized = await this.#connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Domovoi", version: buildVersion },
      })
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version ${initialized.protocolVersion} is unsupported`)
      }
      this.#capabilities = initialized.agentCapabilities
    } catch (error) {
      this.#closing = true
      this.#process = undefined
      this.#connection = undefined
      this.#capabilities = undefined
      // Bounded: a child that ignores the first signal is killed.
      await terminateProcess(process).catch(() => undefined)
      throw error
    }
  }

  async startSession(cwd: string): Promise<AcpSessionSetup> {
    const connection = this.#requireConnection()
    const response = await answered(connection.newSession({ cwd, mcpServers: [] }))
    return mapAcpSessionSetup(response)
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpSessionSetup> {
    const connection = this.#requireConnection()
    if (this.#capabilities?.sessionCapabilities?.resume) {
      const response = await answered(connection.resumeSession({ sessionId, cwd, mcpServers: [] }))
      return mapAcpSessionSetup({ sessionId, ...response })
    }
    if (this.#capabilities?.loadSession) {
      const response = await answered(connection.loadSession({ sessionId, cwd, mcpServers: [] }))
      return mapAcpSessionSetup({ sessionId, ...response })
    }
    throw new AcpSessionNotOpenedError(`${this.#definition.id} does not support session resume or load`)
  }

  async closeSession(sessionId: string): Promise<boolean> {
    if (!this.#capabilities?.sessionCapabilities?.close) return false
    await this.#requireConnection().closeSession({ sessionId })
    return true
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    await this.#requireConnection().setSessionMode({ sessionId, modeId: mode })
  }

  async setConfig(sessionId: string, optionId: string, value: string): Promise<void> {
    await this.#requireConnection().setSessionConfigOption({ sessionId, configId: optionId, value })
  }

  async prompt(sessionId: string, prompt: string): Promise<{ stopReason: string }> {
    const response = await this.#requireConnection().prompt({
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    })
    return { stopReason: response.stopReason }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#requireConnection().cancel({ sessionId })
  }

  async close(): Promise<void> {
    this.#closing = true
    const process = this.#process
    this.#process = undefined
    this.#connection = undefined
    this.#capabilities = undefined
    if (process) await terminateProcess(process)
    const directory = this.#directory
    this.#directory = undefined
    if (directory) await removeDirectory(directory)
  }

  // The agent runs in an empty folder inside a private launch root, not the
  // daemon's own directory, which may be a repository whose configuration the
  // agent would load at startup. Each session's worktree reaches the agent as
  // the ACP session cwd. A launch root inside a repository, or below held-back
  // configuration, is refused before anything is made in it: a repository's
  // files can change while the agent runs, and nothing watches them there.
  async #spawnFirstAvailable(): Promise<ChildProcessWithoutNullStreams> {
    // Synchronous so the child is spawned in the same turn as before.
    const problem = launchRootProblem(this.#launchRoot, this.#definition.heldBackRepositoryFiles)
    if (problem !== undefined) {
      throw new Error(
        `${this.#definition.id} cannot start, because ${problem}. `
        + "Domovoi starts it only from a private folder outside any repository.",
      )
    }
    reapLaunchDirectories(this.#launchRoot)
    const directory = mkdtempSync(join(this.#launchRoot, `${process.pid}-`))
    const environment = launchEnvironment(directory, this.#daemonDirectory)
    let lastError: unknown
    for (const command of this.#definition.commands) {
      try {
        const process = await spawned(this.#spawn(command, this.#definition.launchArgs, { cwd: directory, env: environment }))
        onProcessEnd(process, () => void removeDirectory(directory))
        this.#directory = directory
        return process
      } catch (error) {
        lastError = error
        if (!isMissingCommand(error)) break
      }
    }
    await removeDirectory(directory)
    throw lastError ?? new Error(`${this.#definition.id} CLI is unavailable`)
  }

  #sessionUpdate(notification: SessionNotification): void {
    for (const update of mapAcpUpdate(notification.update)) {
      this.#handlers.onUpdate(notification.sessionId, update)
    }
  }

  async #requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const mapped = await this.#handlers.onPermission(mapPermissionRequest(request))
    return "cancelled" in mapped
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: mapped.optionId } }
  }

  #requireConnection(): ClientSideConnection {
    if (!this.#connection) throw new Error(`${this.#definition.id} ACP connection is not initialized`)
    return this.#connection
  }
}

export function mapAcpSessionSetup(response: NewSessionResponse): AcpSessionSetup {
  return {
    sessionId: response.sessionId,
    modes: response.modes?.availableModes.map((mode) => mode.id) ?? [],
    configOptions: response.configOptions?.flatMap(mapConfigOption) ?? [],
  }
}

export function mapAcpUpdate(update: SessionUpdate): AcpUpdate[] {
  if (update.sessionUpdate === "agent_message_chunk") {
    return update.content.type === "text" ? [{ type: "text", text: update.content.text }] : []
  }
  if (update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "user_message_chunk") return []
  if (update.sessionUpdate === "plan") {
    return [{
      type: "plan",
      steps: update.entries.map((entry) => ({
        text: entry.content,
        status: entry.status === "in_progress" ? "in-progress" as const : entry.status,
      })),
    }]
  }
  if (update.sessionUpdate === "usage_update") {
    return [{
      type: "usage",
      used: update.used,
      size: update.size,
      ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
    }]
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return []
  const status = update.status
  const mapped: AcpUpdate[] = []
  if (update.sessionUpdate === "tool_call" || status === "completed" || status === "failed") {
    mapped.push({
      type: "tool",
      toolCallId: update.toolCallId,
      phase: status === "completed" || status === "failed" ? "completed" : "started",
      title: update.title ?? "Provider tool",
    })
  }
  for (const content of update.content ?? []) {
    if (content.type === "diff") {
      mapped.push({
        type: "diff",
        diff: `--- ${content.path}\n+++ ${content.path}\n-${content.oldText}\n+${content.newText}`,
      })
    } else if (content.type === "content" && content.content.type === "text") {
      mapped.push({ type: "command", toolCallId: update.toolCallId, output: content.content.text })
    }
  }
  return mapped
}

function mapConfigOption(option: SessionConfigOption): AcpConfigOption[] {
  if (option.type !== "select") return []
  return [{
    id: option.id,
    ...(option.category ? { category: option.category } : {}),
    currentValue: option.currentValue,
    values: option.options.flatMap((candidate) => (
      "options" in candidate ? candidate.options.map((nested) => nested.value) : [candidate.value]
    )),
  }]
}

function mapPermissionRequest(request: RequestPermissionRequest): AcpPermissionRequest {
  const rawInput = request.toolCall.rawInput
  const command = typeof rawInput === "object" && rawInput !== null && "command" in rawInput
    && typeof rawInput.command === "string"
    ? rawInput.command
    : undefined
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? "Provider tool",
    ...(command ? { command } : {}),
    options: request.options.map((option) => ({ id: option.optionId, kind: option.kind })),
  }
}

function spawnAcpProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
}

const staleLaunchMs = 10 * 60 * 1_000
const launchName = /^(\d+)-[A-Za-z0-9]{6}$/

// A request the agent answered with an error opened no session.
async function answered<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (error) {
    if (error instanceof RequestError && error.code !== RequestError.invalidRequest().code) {
      throw new AcpSessionNotOpenedError(error.message, { cause: error })
    }
    throw error
  }
}

// Path-free, so the reason never names a folder outside the session.
function launchRootProblem(root: string, files: readonly string[]): string | undefined {
  try {
    const resolved = resolvedPath(root)
    if (repositoryRootOf(root) !== undefined || repositoryRootOf(resolved) !== undefined) {
      return "its launch folder is inside a repository"
    }
    if (repositoryFileFrom(root, files) !== undefined || repositoryFileFrom(resolved, files) !== undefined) {
      return "a folder above its launch folder holds configuration it would load"
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const found = lstatSync(root)
    const uid = process.getuid?.()
    if (!found.isDirectory() || (uid !== undefined && found.uid !== uid)) {
      return "its launch folder is not a private folder of this user"
    }
    if (process.platform !== "win32") chmodSync(root, 0o700)
  } catch {
    return "Domovoi could not check or prepare its launch folder"
  }
  return undefined
}

// The path with every existing part resolved through links.
function resolvedPath(path: string): string {
  const missing: string[] = []
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing)
    } catch {
      if (dirname(current) === current) return resolve(path)
      missing.unshift(basename(current))
    }
  }
}

// Working directories the daemon inherited from its shell or package manager.
// The agent gets its own launch folder as PWD and none of these.
const inheritedDirectoryVariables = [
  "OLDPWD", "INIT_CWD", "PROJECT_CWD", "npm_config_local_prefix", "npm_package_json", "DIRENV_DIR", "DIRENV_FILE",
]

// Variables that make a program load code as it starts.
const codeLoadingVariables = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV"]

// The agent's environment is the daemon's, less anything that points into the
// checkout the daemon was started from: PATH keeps only absolute entries
// outside it, which is also where the agent command is looked up, and any
// other variable naming a path inside it is dropped.
function launchEnvironment(directory: string, daemonDirectory: string): NodeJS.ProcessEnv {
  const checkout = daemonCheckout(daemonDirectory)
  const inside = (entry: string) => checkout !== undefined && isAbsolute(entry) && checkout.some((root) => {
    const path = relative(root, resolve(entry))
    return path === "" || (!path.startsWith("..") && !isAbsolute(path))
  })
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [...inheritedDirectoryVariables, ...codeLoadingVariables]) delete environment[name]
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (name.toUpperCase() === "PATH") {
      environment[name] = value.split(delimiter).filter((entry) => isAbsolute(entry) && !inside(entry)).join(delimiter)
    } else if (value.split(delimiter).some(inside)) {
      delete environment[name]
    }
  }
  environment.PWD = directory
  return environment
}

// The repository the daemon runs in, as given and resolved. The home folder
// is not treated as one, or every path under it would count.
function daemonCheckout(directory: string): string[] | undefined {
  try {
    const root = repositoryRootOf(directory)
    if (root === undefined) return undefined
    const resolved = realpathSync(root)
    if (resolved === realpathSync(homedir())) return undefined
    return [...new Set([resolve(root), resolved])]
  } catch {
    return undefined
  }
}

// A daemon that stopped without closing its agents leaves their launch folders
// behind in the private launch root, which only this user can write. A folder
// is removed only when it is a real folder this user owns, the daemon that made
// it (named in the folder) is no longer running, and it has not changed for
// staleLaunchMs. It is moved aside first and removed only if what was moved is
// the folder that was checked.
function reapLaunchDirectories(root: string): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  const uid = process.getuid?.()
  for (const name of names) {
    const pid = Number(launchName.exec(name)?.[1])
    if (!Number.isSafeInteger(pid) || pid === process.pid || isRunning(pid)) continue
    const path = join(root, name)
    try {
      const found = lstatSync(path)
      if (!found.isDirectory() || (uid !== undefined && found.uid !== uid)) continue
      if (Date.now() - found.mtimeMs < staleLaunchMs) continue
      const moved = join(root, `.reaping-${randomUUID()}`)
      renameSync(path, moved)
      const checked = lstatSync(moved)
      if (checked.isDirectory() && checked.ino === found.ino && checked.dev === found.dev) {
        rmSync(moved, { recursive: true, force: true })
      }
    } catch {
      // Another daemon may be reaping the same folder.
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

function spawned(process: ChildProcessWithoutNullStreams): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    process.once("spawn", () => resolve(process))
    process.once("error", reject)
  })
}

function captureStderrTail(stream: Readable): () => string {
  let tail = Buffer.alloc(0)
  stream.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
  })
  return () => tail.toString("utf8").trim()
}

function exitReason(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const exit = code !== null
    ? `${id} exited with code ${code}`
    : `${id} exited from signal ${signal ?? "unknown"}`
  return stderr ? `${exit}: ${stderr}` : exit
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function terminateProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  const exit = processExit(process)
  try {
    if (!process.kill()) {
      exit.cancel()
      return
    }
  } catch {
    exit.cancel()
    return
  }
  if (await settlesBefore(exit.promise, ACP_CLOSE_GRACE_MS)) return
  try {
    if (!process.kill("SIGKILL")) {
      exit.cancel()
      return
    }
  } catch {
    exit.cancel()
    return
  }
  await settlesBefore(exit.promise, ACP_FORCE_CLOSE_MS)
  exit.cancel()
}

function processExit(process: ChildProcessWithoutNullStreams): {
  promise: Promise<void>
  cancel(): void
} {
  let cancel = () => {}
  const promise = new Promise<void>((resolve) => {
    let settled = false
    const onExit = () => finish()
    function finish(): void {
      if (settled) return
      settled = true
      process.off("exit", onExit)
      resolve()
    }
    cancel = finish
    process.once("exit", onExit)
  })
  return { promise, cancel }
}

function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => finish(false), timeoutMs)
    function finish(result: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    void promise.then(() => finish(true))
  })
}
