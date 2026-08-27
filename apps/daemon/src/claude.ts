import { randomUUID } from "node:crypto"

import {
  query,
  type Options,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const

export type ClaudeUserMessage = {
  type: "user"
  message: { role: "user"; content: string }
  parent_tool_use_id: null
  uuid: string
  session_id: string
}

export type ClaudeSdkMessage = {
  type: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  event?: unknown
  message?: unknown
  tool_use_result?: unknown
}

type ClaudePermissionContext = {
  signal: AbortSignal
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  toolUseID: string
  agentID?: string
  requestId: string
}

export type ClaudeQueryOptions = {
  cwd?: string
  sessionId?: string
  resume?: string
  model?: string
  effort?: typeof claudeEfforts[number]
  permissionMode?: ClaudePermissionMode
  allowDangerouslySkipPermissions?: boolean
  includePartialMessages?: boolean
  forwardSubagentText?: boolean
  settingSources?: Array<"user" | "project" | "local">
  systemPrompt?: { type: "preset"; preset: "claude_code" }
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ) => Promise<PermissionResult | null>
}

export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  initializationResult(): Promise<unknown>
  supportedModels(): Promise<Array<{
    value: string
    resolvedModel?: string
    displayName: string
    description: string
    supportsEffort?: boolean
    supportedEffortLevels?: readonly typeof claudeEfforts[number][]
  }>>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>
  applyFlagSettings(settings: { effortLevel?: typeof claudeEfforts[number] | null }): Promise<void>
  interrupt(): Promise<unknown>
  close(): void
}

export type ClaudeQueryFactory = (
  input: AsyncIterable<ClaudeUserMessage>,
  options: ClaudeQueryOptions,
) => ClaudeQuery

type Session = {
  threadId: string
  cwd: string
  input: PushStream<ClaudeUserMessage>
  query: ClaudeQuery
  tools: Map<string, { type: "command"; command: string } | { type: "file"; path: string }>
  activeTurnId?: string
}

type PendingApproval = {
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
}

export function claudePermissionFor(runtime: Runtime): {
  permissionMode: ClaudePermissionMode
  allowDangerouslySkipPermissions: boolean
} {
  if (runtime.permissionMode === "plan") {
    return { permissionMode: "plan", allowDangerouslySkipPermissions: false }
  }
  if (runtime.permissionMode === "build" && runtime.auto) {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
  }
  return { permissionMode: "default", allowDangerouslySkipPermissions: false }
}

export class ClaudeAgentSdkAdapter implements AgentAdapter {
  readonly #factory: ClaudeQueryFactory
  readonly #id: () => string
  #sessions = new Map<string, Session>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #nextApprovalId = 0

  constructor(
    factory: ClaudeQueryFactory = defaultClaudeQueryFactory,
    id: () => string = randomUUID,
  ) {
    this.#factory = factory
    this.#id = id
  }

  async connect(): Promise<void> {}

  async listModels(): Promise<ProviderModel[]> {
    const input = new PushStream<ClaudeUserMessage>()
    const runtime = this.#factory(input, { ...baseOptions(), settingSources: [] })
    try {
      await runtime.initializationResult()
      const models = await runtime.supportedModels()
      return models.map((model, index) => {
        const efforts = model.supportsEffort
          ? [...(model.supportedEffortLevels ?? [])]
          : []
        const defaultReasoningEffort = efforts.includes("high")
          ? "high"
          : efforts[0] ?? "medium"
        return {
          provider: "claude-code",
          id: model.value,
          displayName: model.displayName,
          description: model.description,
          supportedReasoningEfforts: efforts,
          defaultReasoningEffort,
          isDefault: index === 0,
        }
      })
    } finally {
      input.close()
      runtime.close()
    }
  }

  async startThread({ cwd, runtime }: { cwd: string; runtime: Runtime }): Promise<string> {
    const threadId = this.#id()
    await this.#openSession(threadId, cwd, runtime, false)
    return threadId
  }

  async resumeThread({ threadId, cwd, runtime }: {
    threadId: string
    cwd: string
    runtime: Runtime
  }): Promise<void> {
    if (this.#sessions.has(threadId)) return
    await this.#openSession(threadId, cwd, runtime, true)
  }

  async startTurn({ threadId, prompt, runtime }: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string> {
    const session = this.#requireSession(threadId)
    const turnId = this.#id()
    await this.#applyRuntime(session, runtime)
    session.activeTurnId = turnId
    session.input.push(userMessage(threadId, turnId, prompt))
    return turnId
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) throw new Error("Claude turn is no longer active")
    session.input.push(userMessage(threadId, this.#id(), prompt))
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) return
    await session.query.interrupt()
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId)
    if (!session) return
    session.input.close()
    session.query.close()
    this.#sessions.delete(threadId)
  }

  resolveApproval(requestId: number, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) return
    this.#pendingApprovals.delete(requestId)
    if (decision === "allow-once") {
      pending.resolve({ behavior: "allow", updatedInput: pending.input })
    } else if (decision === "always-project") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        ...(pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
      })
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by the user" })
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    for (const session of this.#sessions.values()) {
      session.input.close()
      session.query.close()
    }
    this.#sessions.clear()
    for (const pending of this.#pendingApprovals.values()) {
      pending.resolve({ behavior: "deny", message: "Domovoi closed the Claude session" })
    }
    this.#pendingApprovals.clear()
  }

  async #openSession(
    threadId: string,
    cwd: string,
    runtime: Runtime,
    resume: boolean,
  ): Promise<void> {
    const input = new PushStream<ClaudeUserMessage>()
    const permission = claudePermissionFor(runtime)
    const options: ClaudeQueryOptions = {
      ...baseOptions(),
      cwd,
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      model: runtime.model,
      effort: claudeEffortFor(runtime.reasoning),
      permissionMode: permission.permissionMode,
      // Enables a later manual → auto mode switch; it does not bypass checks by itself.
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, toolInput, context) =>
        this.#requestApproval(threadId, cwd, toolName, toolInput, context),
    }
    const query = this.#factory(input, options)
    const session: Session = { threadId, cwd, input, query, tools: new Map() }
    this.#sessions.set(threadId, session)
    void this.#consume(session).catch((error: unknown) => {
      const turnId = session.activeTurnId
      if (!turnId) return
      this.#emit({
        type: "turn-completed",
        params: {
          threadId,
          turnId,
          turn: {
            id: turnId,
            status: "failed",
            error: error instanceof Error ? error.message : "Claude session failed",
          },
        },
      })
      delete session.activeTurnId
    })
    try {
      await query.initializationResult()
    } catch (error) {
      input.close()
      query.close()
      this.#sessions.delete(threadId)
      throw error
    }
  }

  async #applyRuntime(session: Session, runtime: Runtime): Promise<void> {
    const permission = claudePermissionFor(runtime)
    await Promise.all([
      session.query.setModel(runtime.model),
      session.query.setPermissionMode(permission.permissionMode),
      session.query.applyFlagSettings({ effortLevel: claudeEffortFor(runtime.reasoning) }),
    ])
  }

  #requestApproval(
    threadId: string,
    cwd: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ): Promise<PermissionResult> {
    const requestId = ++this.#nextApprovalId
    const session = this.#requireSession(threadId)
    const command = typeof input.command === "string" ? input.command : toolName
    const reason = context.title ?? context.description ?? context.decisionReason
    this.#emit({
      type: "approval-requested",
      requestId,
      threadId,
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      itemId: context.toolUseID,
      command,
      cwd: context.blockedPath ?? cwd,
      ...(reason ? { reason } : {}),
    })
    return new Promise((resolve) => {
      this.#pendingApprovals.set(requestId, {
        input,
        ...(context.suggestions ? { suggestions: context.suggestions } : {}),
        resolve,
      })
      context.signal.addEventListener("abort", () => {
        const pending = this.#pendingApprovals.get(requestId)
        if (!pending) return
        this.#pendingApprovals.delete(requestId)
        pending.resolve({ behavior: "deny", message: "Claude cancelled the tool request" })
      }, { once: true })
    })
  }

  async #consume(session: Session): Promise<void> {
    for await (const message of session.query) this.#receive(session, message)
  }

  #receive(session: Session, message: ClaudeSdkMessage): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    if (message.type === "stream_event") {
      const event = asRecord(message.event)
      const delta = asRecord(event?.delta)
      if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        this.#emit({
          type: "text-delta",
          threadId: session.threadId,
          turnId,
          delta: delta.text,
        })
      }
      return
    }
    if (message.type === "assistant") {
      this.#receiveAssistant(session, turnId, message.message)
      return
    }
    if (message.type === "user") {
      this.#receiveUser(session, turnId, message.message, message.tool_use_result)
      return
    }
    if (message.type === "result") {
      const failed = message.is_error === true || message.subtype !== "success"
      this.#emit({
        type: "turn-completed",
        params: {
          threadId: session.threadId,
          turnId,
          turn: { id: turnId, status: failed ? "failed" : "completed" },
        },
      })
      delete session.activeTurnId
    }
  }

  #receiveAssistant(session: Session, turnId: string, rawMessage: unknown): void {
    const message = asRecord(rawMessage)
    if (!Array.isArray(message?.content)) return
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock)
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue
      const input = asRecord(block.input) ?? {}
      if (block.name === "Bash") {
        const command = typeof input.command === "string" ? input.command : "Bash"
        session.tools.set(block.id, { type: "command", command })
        this.#emit({
          type: "item",
          phase: "started",
          params: {
            threadId: session.threadId,
            turnId,
            item: {
              type: "commandExecution",
              id: block.id,
              command: [command],
              status: "inProgress",
            },
          },
        })
      }
      if ((block.name === "Edit" || block.name === "Write") && typeof input.file_path === "string") {
        session.tools.set(block.id, { type: "file", path: input.file_path })
      }
    }
  }

  #receiveUser(
    session: Session,
    turnId: string,
    rawMessage: unknown,
    rawToolResult: unknown,
  ): void {
    const message = asRecord(rawMessage)
    if (!Array.isArray(message?.content)) return
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock)
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      const tracked = session.tools.get(block.tool_use_id)
      if (!tracked) continue
      session.tools.delete(block.tool_use_id)
      const failed = block.is_error === true
      if (tracked.type === "command") {
        this.#emit({
          type: "item",
          phase: "completed",
          params: {
            threadId: session.threadId,
            turnId,
            item: {
              type: "commandExecution",
              id: block.tool_use_id,
              command: [tracked.command],
              status: failed ? "failed" : "completed",
              aggregatedOutput: toolOutput(rawToolResult, block.content),
            },
          },
        })
      } else if (!failed) {
        this.#emit({
          type: "item",
          phase: "completed",
          params: {
            threadId: session.threadId,
            turnId,
            item: {
              type: "fileChange",
              id: block.tool_use_id,
              changes: [{ path: tracked.path }],
            },
          },
        })
      }
    }
  }

  #requireSession(threadId: string): Session {
    const session = this.#sessions.get(threadId)
    if (!session) throw new Error(`Claude session ${threadId} is not loaded`)
    return session
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

class PushStream<T> implements AsyncIterable<T> {
  #values: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  push(value: T): void {
    if (this.#closed) throw new Error("Claude input stream is closed")
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift()
        if (value !== undefined) return { value, done: false }
        if (this.#closed) return { value: undefined, done: true }
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

function baseOptions(): ClaudeQueryOptions {
  return {
    includePartialMessages: true,
    forwardSubagentText: true,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
  }
}

function userMessage(threadId: string, turnId: string, prompt: string): ClaudeUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    uuid: turnId,
    session_id: threadId,
  }
}

function claudeEffortFor(reasoning: string): typeof claudeEfforts[number] {
  return claudeEfforts.find((effort) => effort === reasoning) ?? "medium"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function toolOutput(result: unknown, fallback: unknown): string {
  const output = asRecord(result)
  if (output) {
    const stdout = typeof output.stdout === "string" ? output.stdout : ""
    const stderr = typeof output.stderr === "string" ? output.stderr : ""
    if (stdout || stderr) return `${stdout}${stderr}`
  }
  if (typeof fallback === "string") return fallback
  return ""
}

const defaultClaudeQueryFactory: ClaudeQueryFactory = (input, options) => query({
  prompt: input as AsyncIterable<SDKUserMessage>,
  options: options as Options,
}) as unknown as ClaudeQuery
