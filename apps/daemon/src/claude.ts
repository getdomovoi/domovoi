import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"

import {
  query,
  type Options,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent, AgentVisualContext } from "./agents.js"
import { normalizeProviderUsage } from "./usage.js"

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const
const claudeAskTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const
const claudeAskDisallowedTools = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "Agent",
  "Skill",
  "mcp__*",
] as const

export type ClaudeMessageId = ReturnType<typeof randomUUID>

export type ClaudeUserMessage = {
  type: "user"
  message: {
    role: "user"
    content: string | Array<
      | { type: "text"; text: string }
      | {
          type: "image"
          source: { type: "base64"; media_type: AgentVisualContext["mimeType"]; data: string }
        }
    >
  }
  parent_tool_use_id: null
  uuid: ClaudeMessageId
  session_id: string
}

export type ClaudeSdkMessage = {
  type: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  errors?: unknown
  event?: unknown
  message?: unknown
  tool_use_result?: unknown
  usage?: unknown
  total_cost_usd?: unknown
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
  tools?: string[]
  disallowedTools?: string[]
  systemPrompt?: { type: "preset"; preset: "claude_code" }
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ) => Promise<PermissionResult | null>
}

export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  initializationResult(): Promise<unknown>
  supportedModels(): Promise<unknown>
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
  runtime: Runtime
  tools: Map<string, { type: "command"; command: string } | { type: "file"; path: string }>
  activeTurnId?: string
  ended?: true
}

type PendingApproval = {
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

export function claudePermissionFor(runtime: Runtime): {
  permissionMode: ClaudePermissionMode
  allowDangerouslySkipPermissions: boolean
} {
  if (runtime.permissionMode === "ask") {
    return { permissionMode: "dontAsk", allowDangerouslySkipPermissions: false }
  }
  if (runtime.permissionMode === "plan") {
    return { permissionMode: "plan", allowDangerouslySkipPermissions: false }
  }
  return { permissionMode: "default", allowDangerouslySkipPermissions: false }
}

export class ClaudeAgentSdkAdapter implements AgentAdapter {
  readonly permissionCapabilities = { ask: "read-only", buildAuto: "pre-execution" } as const
  readonly capabilities = { vision: true } as const
  readonly #factory: ClaudeQueryFactory
  readonly #id: () => ClaudeMessageId
  #sessions = new Map<string, Session>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #nextApprovalId = 0

  constructor(
    factory: ClaudeQueryFactory = defaultClaudeQueryFactory,
    id: () => ClaudeMessageId = randomUUID,
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
      const models = requireClaudeModels(await runtime.supportedModels())
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

  async startTurn({ threadId, prompt, runtime, visualContexts }: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
    visualContexts?: AgentVisualContext[]
  }): Promise<string> {
    let session = this.#requireSession(threadId)
    if (session.ended || isClaudeAsk(session.runtime) !== isClaudeAsk(runtime)) {
      session.input.close()
      session.query.close()
      this.#sessions.delete(threadId)
      await this.#openSession(threadId, session.cwd, runtime, true)
      session = this.#requireSession(threadId)
    }
    const turnId = this.#id()
    await this.#applyRuntime(session, runtime)
    session.activeTurnId = turnId
    session.input.push(userMessage(threadId, turnId, prompt, visualContexts))
    return turnId
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    visualContexts?: AgentVisualContext[],
  ): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) throw new Error("Claude turn is no longer active")
    session.input.push(userMessage(threadId, this.#id(), prompt, visualContexts))
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
    if (decision === "allow-once" || decision === "always-project") {
      pending.resolve({ behavior: "allow", updatedInput: pending.input })
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
      ...claudeBoundaryOptions(runtime),
      cwd,
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      model: runtime.model,
      effort: claudeEffortFor(runtime.reasoning),
      permissionMode: permission.permissionMode,
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      canUseTool: (toolName, toolInput, context) =>
        this.#requestApproval(threadId, cwd, toolName, toolInput, context),
    }
    const query = this.#factory(input, options)
    const session: Session = { threadId, cwd, input, query, runtime, tools: new Map() }
    this.#sessions.set(threadId, session)
    void this.#consume(session).then(
      () => this.#endSession(session, "Claude session connection closed before the turn completed"),
      (error: unknown) => this.#endSession(
        session,
        error instanceof Error ? error.message : "Claude session failed",
      ),
    )
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
    session.runtime = runtime
  }

  #requestApproval(
    threadId: string,
    cwd: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ): Promise<PermissionResult> {
    const session = this.#requireSession(threadId)
    if (session.runtime.permissionMode === "ask") {
      if (!claudeAskTools.includes(toolName as typeof claudeAskTools[number])) {
        return Promise.resolve({ behavior: "deny", message: "Ask mode is read-only" })
      }
      return Promise.resolve({ behavior: "allow", updatedInput: input })
    }
    const requestId = ++this.#nextApprovalId
    const command = typeof input.command === "string" ? input.command : toolName
    const reason = context.title ?? context.description ?? context.decisionReason
    const filePath = typeof input.file_path === "string" ? input.file_path.trim() : undefined
    this.#emit({
      type: "approval-requested",
      requestId,
      threadId,
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      itemId: context.toolUseID,
      command,
      cwd: context.blockedPath ?? cwd,
      ...(filePath ? { path: isAbsolute(filePath) ? filePath : resolve(cwd, filePath) } : {}),
      ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}),
      ...(reason ? { reason } : {}),
    })
    return new Promise((resolve) => {
      this.#pendingApprovals.set(requestId, {
        input,
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

  #endSession(session: Session, reason: string): void {
    if (this.#sessions.get(session.threadId) !== session) return
    session.ended = true
    const turnId = session.activeTurnId
    if (!turnId) return
    delete session.activeTurnId
    this.#emit({
      type: "turn-completed",
      params: {
        threadId: session.threadId,
        turnId,
        turn: { id: turnId, status: "failed", error: reason },
      },
    })
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
      const usage = normalizeProviderUsage(message)
      if (usage) this.#emit({ type: "usage", threadId: session.threadId, turnId, usage })
      const failed = message.is_error === true || message.subtype !== "success"
      const error = failed ? resultError(message) : undefined
      this.#emit({
        type: "turn-completed",
        params: {
          threadId: session.threadId,
          turnId,
          turn: {
            id: turnId,
            status: failed ? "failed" : "completed",
            ...(error ? { error } : {}),
          },
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

function isClaudeAsk(runtime: Runtime): boolean {
  return runtime.permissionMode === "ask"
}

function claudeBoundaryOptions(runtime: Runtime): ClaudeQueryOptions {
  if (!isClaudeAsk(runtime)) return {}
  return {
    settingSources: [],
    tools: [...claudeAskTools],
    disallowedTools: [...claudeAskDisallowedTools],
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

function userMessage(
  threadId: string,
  turnId: ClaudeMessageId,
  prompt: string,
  visualContexts: AgentVisualContext[] = [],
): ClaudeUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: visualContexts.length === 0
        ? prompt
        : [
            { type: "text", text: prompt },
            ...visualContexts.map((context) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: context.mimeType,
                data: Buffer.from(context.bytes).toString("base64"),
              },
            })),
          ],
    },
    parent_tool_use_id: null,
    uuid: turnId,
    session_id: threadId,
  }
}

function claudeEffortFor(reasoning: string): typeof claudeEfforts[number] {
  return claudeEfforts.find((effort) => effort === reasoning) ?? "medium"
}

type ClaudeModel = {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly typeof claudeEfforts[number][]
}

function requireClaudeModels(value: unknown): ClaudeModel[] {
  if (!Array.isArray(value)) throw new Error("Claude model catalog returned invalid data")
  return value.map((candidate) => {
    const model = asRecord(candidate)
    const efforts = model?.supportedEffortLevels
    if (
      !model
      || typeof model.value !== "string"
      || typeof model.displayName !== "string"
      || typeof model.description !== "string"
      || (model.supportsEffort !== undefined && typeof model.supportsEffort !== "boolean")
      || (efforts !== undefined && (
        !Array.isArray(efforts)
        || efforts.some((effort) => !claudeEfforts.some((candidate) => candidate === effort))
      ))
    ) throw new Error("Claude model catalog returned invalid data")
    return {
      value: model.value,
      displayName: model.displayName,
      description: model.description,
      ...(typeof model.supportsEffort === "boolean" ? { supportsEffort: model.supportsEffort } : {}),
      ...(Array.isArray(efforts)
        ? { supportedEffortLevels: claudeEfforts.filter((effort) => efforts.includes(effort)) }
        : {}),
    }
  })
}

function resultError(message: ClaudeSdkMessage): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string")
    : []
  const subtype = message.subtype && message.subtype !== "success" ? message.subtype : ""
  return [subtype, errors.join("; ")].filter(Boolean).join(": ")
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
  prompt: input satisfies AsyncIterable<SDKUserMessage>,
  options: options satisfies Options,
})
