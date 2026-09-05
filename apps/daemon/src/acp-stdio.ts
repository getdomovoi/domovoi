import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
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

type ProcessSpawner = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams
const ACP_CLOSE_GRACE_MS = 1_000
const ACP_FORCE_CLOSE_MS = 1_000
const STDERR_TAIL_BYTES = 16_384

export class StdioAcpPeer implements AcpPeer {
  readonly #definition: AcpProviderDefinition
  readonly #handlers: AcpPeerHandlers
  readonly #spawn: ProcessSpawner
  #process: ChildProcessWithoutNullStreams | undefined
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
    process.once("exit", (code, signal) => {
      if (this.#process !== process) return
      this.#process = undefined
      this.#connection = undefined
      this.#capabilities = undefined
      if (!this.#closing) {
        this.#handlers.onDisconnect(exitReason(this.#definition.id, code, signal, stderrTail()))
      }
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
  }

  async #spawnFirstAvailable(): Promise<ChildProcessWithoutNullStreams> {
    let lastError: unknown
    for (const command of this.#definition.commands) {
      try {
        return await spawned(this.#spawn(command, this.#definition.launchArgs))
      } catch (error) {
        lastError = error
        if (!isMissingCommand(error)) throw error
      }
    }
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

function spawnAcpProcess(command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] })
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
