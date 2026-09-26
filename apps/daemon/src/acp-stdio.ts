import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

import { buildVersion } from "@getdomovoi/protocol"

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type Client,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"

import type {
  AcpConfigOption,
  AcpPeer,
  AcpPeerHandlers,
  AcpPermissionRequest,
  AcpSessionSetup,
  AcpUpdate,
} from "./acp.js"
import type { AcpProviderDefinition } from "./acp-providers.js"
import { repositoryFileFrom } from "./codex-repository-config.js"
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
  #process: ChildProcessWithoutNullStreams | undefined
  #directory: string | undefined
  #connection: ClientSideConnection | undefined
  #capabilities: AgentCapabilities | undefined
  #closing = false

  constructor(input: {
    definition: AcpProviderDefinition
    handlers: AcpPeerHandlers
    spawnProcess?: ProcessSpawner
  }) {
    this.#definition = input.definition
    this.#handlers = input.handlers
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
      try {
        process.kill()
      } catch {
        // Preserve the initialization failure after detaching the child.
      }
      throw error
    }
  }

  async startSession(cwd: string): Promise<AcpSessionSetup> {
    const response = await this.#requireConnection().newSession({ cwd, mcpServers: [] })
    return mapAcpSessionSetup(response)
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpSessionSetup> {
    const connection = this.#requireConnection()
    if (this.#capabilities?.sessionCapabilities?.resume) {
      const response = await connection.resumeSession({ sessionId, cwd, mcpServers: [] })
      return mapAcpSessionSetup({ sessionId, ...response })
    }
    if (this.#capabilities?.loadSession) {
      const response = await connection.loadSession({ sessionId, cwd, mcpServers: [] })
      return mapAcpSessionSetup({ sessionId, ...response })
    }
    throw new Error(`${this.#definition.id} does not support session resume or load`)
  }

  async closeSession(sessionId: string): Promise<void> {
    if (this.#capabilities?.sessionCapabilities?.close) {
      await this.#requireConnection().closeSession({ sessionId })
    }
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

  // The agent runs in an empty private folder, not the daemon's own directory,
  // which may be a repository whose configuration the agent would load at
  // startup. Each session's worktree reaches the agent as the ACP session cwd.
  // The folder is refused when the temporary folder sits where the agent would
  // load held-back configuration from, as a session directory would be.
  async #spawnFirstAvailable(): Promise<ChildProcessWithoutNullStreams> {
    // Synchronous so the child is spawned in the same turn as before.
    reapLaunchDirectories()
    const directory = mkdtempSync(join(tmpdir(), `${launchPrefix}${process.pid}-`))
    let reason: string | undefined
    try {
      const file = repositoryFileFrom(directory, this.#definition.heldBackRepositoryFiles)
      if (file !== undefined) reason = `it would load ${file} from a folder above it`
    } catch {
      reason = "Domovoi could not check the folders above it"
    }
    if (reason !== undefined) {
      rmSync(directory, { recursive: true, force: true })
      throw new Error(
        `${this.#definition.id} cannot start in the temporary folder, because ${reason}. `
        + "Set TMPDIR, or TEMP on Windows, to a folder outside any repository.",
      )
    }
    const environment = launchEnvironment(directory)
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

const launchPrefix = "domovoi-acp-"
const staleLaunchMs = 10 * 60 * 1_000

// Working directories the daemon inherited from its shell or package manager.
// The agent gets its own launch folder as PWD and none of these.
const inheritedDirectoryVariables = [
  "OLDPWD", "INIT_CWD", "PROJECT_CWD", "npm_config_local_prefix", "npm_package_json", "DIRENV_DIR", "DIRENV_FILE",
]

function launchEnvironment(directory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PWD: directory }
  for (const name of inheritedDirectoryVariables) delete environment[name]
  return environment
}

// A daemon that stopped without closing its agents leaves their launch folders
// behind. A folder is removed only when this user owns it, it is a real folder,
// the daemon that made it (named in the folder) is no longer running, and it
// has not changed for staleLaunchMs.
function reapLaunchDirectories(): void {
  const root = tmpdir()
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  const uid = process.getuid?.()
  for (const name of names) {
    const pid = Number(name.slice(launchPrefix.length).match(/^(\d+)-/)?.[1])
    if (!name.startsWith(launchPrefix) || !Number.isSafeInteger(pid) || pid === process.pid || isRunning(pid)) continue
    const path = join(root, name)
    try {
      const found = lstatSync(path)
      if (!found.isDirectory() || (uid !== undefined && found.uid !== uid)) continue
      if (Date.now() - found.mtimeMs < staleLaunchMs) continue
      rmSync(path, { recursive: true, force: true })
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
