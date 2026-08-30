import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Readable, Writable } from "node:stream"

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
    this.#process = process
    process.once("exit", () => {
      if (!this.#closing) this.#handlers.onDisconnect()
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
        clientInfo: { name: "Domovoi", version: "0.0.1" },
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
    this.#process?.kill()
    this.#process = undefined
    this.#connection = undefined
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
      text: update.entries.map((entry) => `- [${planMarker(entry.status)}] ${entry.content}`).join("\n"),
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

function planMarker(status: "pending" | "in_progress" | "completed"): string {
  if (status === "completed") return "x"
  if (status === "in_progress") return "~"
  return " "
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

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
