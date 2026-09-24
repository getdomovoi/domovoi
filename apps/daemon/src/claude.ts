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

import type {
  AgentAdapter,
  AgentEvent,
  AgentVisualContext,
  AgentWorkingPlanStep,
} from "./agents.js"
import { claudeReadOutsideWorktree, claudeShellReadIsListed, isClaudeReadTool } from "./claude-read-scope.js"
import { gitReadCanRunProgram } from "./git-read-config.js"
import { permissionDecisionFor } from "./permission-policy.js"
import { DurableOutputRedactor, redactDurableText } from "./secret-redaction.js"
import { checkClaudeInstall, resolveClaudeSdkExecutable } from "./claude-install.js"
import { normalizeProviderUsage } from "./usage.js"

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const
const maximumClaudeStderrBytes = 16_384
const claudeAskTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const
const claudeContextUsageTimeoutMs = 250

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
  error?: unknown
  errors?: unknown
  event?: unknown
  message?: unknown
  result?: unknown
  tool_use_result?: unknown
  usage?: unknown
  total_cost_usd?: unknown
  user_message_uuid?: unknown
  user_message_uuids?: unknown
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
  hooks?: { PreToolUse?: Array<{ hooks: ClaudePreToolUseHook[] }> }
  stderr?: (data: string) => void
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ) => Promise<PermissionResult | null>
}

export type ClaudePreToolUseHook = (
  input: {
    hook_event_name: string
    cwd?: string
    tool_name?: string
    tool_input?: unknown
    tool_use_id?: string
  },
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<{
  hookSpecificOutput?: {
    hookEventName: "PreToolUse"
    permissionDecision: "ask" | "deny"
    permissionDecisionReason: string
  }
}>

export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  initializationResult(): Promise<unknown>
  supportedModels(): Promise<unknown>
  getContextUsage(): Promise<unknown>
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
  // Tool calls the PreToolUse hook sent to an approval, by tool use id, with
  // the reason the approval card should give.
  screenedReads: Map<string, { reason: string; path?: string }>
  stderr: ClaudeStderrTail
  activeTurnId?: string
  // The uuids of the user messages sent for the active turn: its prompt and
  // any steering. A result names the messages it answered.
  turnMessageIds: Set<string>
  // The uuids of turns that were interrupted and whose own result has not come
  // back yet. Only a result naming one of these is dropped: a result naming a
  // uuid the SDK made itself (a compaction, a merged queue) ends the turn.
  interruptedMessageIds: Set<string>
  assistantError?: string
  // Set once a turn has been sent. Claude has no conversation to resume until
  // then, so a reopen before it must start a fresh one.
  started?: true
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
  readonly #preflight: (() => Promise<void>) | undefined
  #sessions = new Map<string, Session>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #nextApprovalId = 0

  constructor(
    factory: ClaudeQueryFactory = defaultClaudeQueryFactory,
    id: () => ClaudeMessageId = randomUUID,
    // The install check runs here, asynchronously, before the synchronous
    // factory. An injected factory brings no executable to check.
    preflight: (() => Promise<void>) | undefined = factory === defaultClaudeQueryFactory
      ? () => checkClaudeInstall(process.env.PATH ?? "", process.platform)
      : undefined,
  ) {
    this.#factory = factory
    this.#id = id
    this.#preflight = preflight
  }

  async connect(): Promise<void> {}

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    signal?.throwIfAborted()
    if (this.#preflight) {
      await this.#preflight()
      signal?.throwIfAborted()
    }
    const input = new PushStream<ClaudeUserMessage>()
    const stderr = new ClaudeStderrTail()
    const runtime = this.#factory(input, {
      ...baseOptions(),
      settingSources: [],
      stderr: (data) => stderr.push(data),
    })
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      input.close()
      runtime.close()
    }
    signal?.addEventListener("abort", close, { once: true })
    try {
      await runtime.initializationResult()
      signal?.throwIfAborted()
      const models = requireClaudeModels(await runtime.supportedModels())
      signal?.throwIfAborted()
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
    } catch (error) {
      throw claudeFailureError(error, stderr.take())
    } finally {
      signal?.removeEventListener("abort", close)
      close()
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
    // A mode change no longer restarts anything: the tool boundary moved to
    // #requestApproval, and Claude's own mode is applied live by #applyRuntime
    // below. Only a session that has ended needs reopening.
    if (session.ended) {
      const previous = session
      this.#sessions.delete(threadId)
      try {
        // Resume only a conversation that exists. Moving the mode before the
        // first turn used to ask Claude to resume a session it had never
        // opened, which failed with "No conversation found".
        await this.#openSession(threadId, previous.cwd, runtime, previous.started === true)
      } catch (error) {
        // Put back what was working. Dropping the session here made the first
        // failure permanent: every later send found nothing and reported that
        // the session was not loaded, which hid the real cause.
        if (!this.#sessions.has(threadId)) this.#sessions.set(threadId, previous)
        throw error
      }
      previous.input.close()
      previous.query.close()
      session = this.#requireSession(threadId)
    }
    const turnId = this.#id()
    session.stderr.clear()
    delete session.assistantError
    await this.#applyRuntime(session, runtime)
    session.activeTurnId = turnId
    session.turnMessageIds = new Set([turnId])
    session.input.push(userMessage(threadId, turnId, prompt, visualContexts))
    session.started = true
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
    const messageId = this.#id()
    session.turnMessageIds.add(messageId)
    session.input.push(userMessage(threadId, messageId, prompt, visualContexts))
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) return
    for (const id of session.turnMessageIds) session.interruptedMessageIds.add(id)
    // Bounded: a result that never comes must not hold its uuids forever.
    while (session.interruptedMessageIds.size > maximumInterruptedMessageIds) {
      const oldest = session.interruptedMessageIds.values().next().value
      if (oldest === undefined) break
      session.interruptedMessageIds.delete(oldest)
    }
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
    if (this.#preflight) await this.#preflight()
    const input = new PushStream<ClaudeUserMessage>()
    const stderr = new ClaudeStderrTail()
    const permission = claudePermissionFor(runtime)
    const options: ClaudeQueryOptions = {
      ...baseOptions(),
      cwd,
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      model: runtime.model,
      effort: claudeEffortFor(runtime.reasoning),
      permissionMode: permission.permissionMode,
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      canUseTool: (toolName, toolInput, context) =>
        this.#requestApproval(threadId, cwd, toolName, toolInput, context),
      hooks: {
        PreToolUse: [{ hooks: [(hookInput) => this.#screenToolUse(threadId, cwd, hookInput)] }],
      },
      stderr: (data) => stderr.push(data),
    }
    const query = this.#factory(input, options)
    const session: Session = {
      threadId,
      cwd,
      input,
      query,
      runtime,
      tools: new Map(),
      screenedReads: new Map(),
      turnMessageIds: new Set(),
      interruptedMessageIds: new Set(),
      stderr,
    }
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
      throw claudeFailureError(error, stderr.take())
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

  // Claude Code runs its read-only commands and approves reads inside its
  // working directory before canUseTool is asked. A read that can leave the
  // session worktree, or that names a secret, is sent back through the
  // approval path instead; Ask has no approvals, so there it is refused.
  async #screenToolUse(
    threadId: string,
    cwd: string,
    hookInput: Parameters<ClaudePreToolUseHook>[0],
  ): Promise<Awaited<ReturnType<ClaudePreToolUseHook>>> {
    const session = this.#sessions.get(threadId)
    const toolName = hookInput.tool_name
    if (!session || hookInput.hook_event_name !== "PreToolUse" || typeof toolName !== "string") return {}
    if (toolName !== "Bash" && !isClaudeReadTool(toolName)) return {}
    const toolInput = asRecord(hookInput.tool_input) ?? {}
    const outside = await claudeReadOutsideWorktree(toolName, toolInput, cwd, hookInput.cwd ?? cwd)
    const command = typeof toolInput.command === "string" ? toolInput.command : toolName
    const operation = [command, ...Object.values(toolInput).filter((value) => typeof value === "string")].join("\n")
    const secret = permissionDecisionFor({ runtime: session.runtime, command: operation }).risk === "hard-gate"
    // Outside the short list, a Bash read may reach paths only known at run
    // time, so it asks even when every path it names stays inside.
    const listed = toolName !== "Bash" || claudeShellReadIsListed(command)
    // A listed Git read still runs any program Git is configured to run.
    const unresolved = !listed || (toolName === "Bash" && /(?:^|[;&|]\s*)git\s/.test(command)
      && await gitReadCanRunProgram(resolve(cwd, hookInput.cwd ?? cwd)))
    if (outside === undefined && !secret && !unresolved) return {}
    const reason = outside !== undefined
      ? `Reads outside the session worktree: ${outside}`
      : secret
        ? "Reads credentials, private keys or environment secrets"
        : "Domovoi cannot tell which files this command reads"
    const itemId = hookInput.tool_use_id
    if (session.runtime.permissionMode === "ask") {
      this.#emit({
        type: "policy-refused",
        threadId,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        ...(itemId ? { itemId } : {}),
        command,
        reason,
      })
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    }
    // A command Domovoi only cannot place keeps Claude's own card text.
    if (itemId && (outside !== undefined || secret)) {
      const path = typeof toolInput.path === "string" && isClaudeReadTool(toolName) ? toolInput.path : undefined
      session.screenedReads.set(itemId, { reason, ...(path ? { path } : {}) })
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }
  }

  #requestApproval(
    threadId: string,
    cwd: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudePermissionContext,
  ): Promise<PermissionResult> {
    const session = this.#requireSession(threadId)
    const command = typeof input.command === "string" ? input.command : toolName
    const screened = session.screenedReads.get(context.toolUseID)
    session.screenedReads.delete(context.toolUseID)
    const reason = screened?.reason ?? context.title ?? context.description ?? context.decisionReason
    if (session.runtime.permissionMode === "ask") {
      if (!claudeAskTools.includes(toolName as typeof claudeAskTools[number])) {
        this.#emit({
          type: "policy-refused",
          threadId,
          ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
          itemId: context.toolUseID,
          command,
          reason: reason ?? toolName,
        })
        return Promise.resolve({ behavior: "deny", message: "Ask mode is read-only" })
      }
      return Promise.resolve({ behavior: "allow", updatedInput: input })
    }
    const requestId = ++this.#nextApprovalId
    const filePath = typeof input.file_path === "string"
      ? input.file_path.trim()
      : typeof input.notebook_path === "string" ? input.notebook_path.trim() : screened?.path?.trim()
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
    for await (const message of session.query) await this.#receive(session, message)
  }

  #endSession(session: Session, reason: string): void {
    if (this.#sessions.get(session.threadId) !== session) return
    session.ended = true
    const turnId = session.activeTurnId
    if (!turnId) return
    delete session.activeTurnId
    const error = claudeFailureDetail([session.assistantError, reason, session.stderr.take()])
    delete session.assistantError
    this.#emit({
      type: "turn-completed",
      params: {
        threadId: session.threadId,
        turnId,
        turn: { id: turnId, status: "failed", error },
      },
    })
  }

  async #receive(session: Session, message: ClaudeSdkMessage): Promise<void> {
    const turnId = session.activeTurnId
    if (!turnId) return
    if (typeof message.error === "string") session.assistantError = message.error
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
      // An interrupted turn's own result arrives after the interrupt returns,
      // and by then the next turn may hold the slot. A result that names only
      // an interrupted turn's messages is that turn's, and ends nothing. Any
      // other result, including one naming a uuid the SDK made itself or none
      // at all, ends the active turn as before.
      const answered = resultMessageIds(message)
      if (answered?.some((id) => session.interruptedMessageIds.has(id))) {
        for (const id of answered) session.interruptedMessageIds.delete(id)
        if (!answered.some((id) => session.turnMessageIds.has(id))) return
      }
      const failed = message.is_error === true || message.subtype !== "success"
      const context = failed ? {} : await claudeContextOccupancy(session.query)
      // The reply has already reached the person. A counter that does not add
      // up is an accounting problem, not a failed turn, so the usage is dropped
      // and the turn is delivered as what it was.
      try {
        const usage = normalizeProviderUsage({ ...message, ...context })
        if (usage) this.#emit({ type: "usage", threadId: session.threadId, turnId, usage })
      } catch {
        // Nothing to report to the person: usage is a readout, not the work.
      }
      const stderr = session.stderr.take()
      const error = failed ? resultError(message, session.assistantError, stderr) : undefined
      delete session.assistantError
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
      if (block.name === "TodoWrite") {
        const steps = claudeTodoSteps(input.todos)
        if (steps) {
          this.#emit({
            type: "plan-updated",
            threadId: session.threadId,
            turnId,
            steps,
          })
        }
        continue
      }
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

class ClaudeStderrTail {
  #tail = Buffer.alloc(0)
  #redactor = new DurableOutputRedactor()

  push(data: string): void {
    this.#append(this.#redactor.push(data))
  }

  #append(data: string): void {
    if (!data) return
    this.#tail = Buffer.concat([this.#tail, Buffer.from(data)])
    if (this.#tail.length > maximumClaudeStderrBytes) {
      this.#tail = this.#tail.subarray(this.#tail.length - maximumClaudeStderrBytes)
    }
  }

  clear(): void {
    this.#tail = Buffer.alloc(0)
    this.#redactor = new DurableOutputRedactor()
  }

  take(): string {
    this.#append(this.#redactor.flush())
    const value = this.#tail.toString("utf8").trim()
    this.clear()
    return value
  }
}


// Ask is enforced per tool call in #requestApproval, against the session's
// current runtime, so it follows a mode change immediately. It used to also be
// declared in the query options as a tool allow-list, which sounds like a
// second lock but is not: the SDK fixes tools when a conversation is created
// and offers no way to change them, so the only way to lift the restriction
// was to start a new conversation. Switching Ask to Build therefore either
// kept the read-only tool set for the life of the session, or threw the
// conversation away. Enforcement lives in one place now, the place that can
// change with the mode.

function baseOptions(): ClaudeQueryOptions {
  return {
    includePartialMessages: true,
    forwardSubagentText: true,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
  }
}

const maximumInterruptedMessageIds = 64

function resultMessageIds(message: ClaudeSdkMessage): string[] | undefined {
  const ids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((id): id is string => typeof id === "string")
    : []
  if (typeof message.user_message_uuid === "string") ids.push(message.user_message_uuid)
  return ids.length > 0 ? ids : undefined
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

function resultError(
  message: ClaudeSdkMessage,
  assistantError: string | undefined,
  stderr: string,
): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string")
    : []
  const subtype = message.subtype && message.subtype !== "success" ? message.subtype : ""
  const result = typeof message.result === "string" ? message.result : ""
  return claudeFailureDetail([subtype, assistantError, result, ...errors, stderr])
}

function claudeFailureError(error: unknown, stderr: string): Error {
  const reason = error instanceof Error ? error.message : "Claude session failed"
  return new Error(claudeFailureDetail([reason, stderr]))
}

function claudeFailureDetail(parts: Array<string | undefined>): string {
  const unique = [...new Set(parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)))]
  return redactDurableText(unique.join(": ")).value
}

async function claudeContextOccupancy(
  query: ClaudeQuery,
): Promise<{ contextTokens?: unknown; contextWindowTokens?: unknown }> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const report = asRecord(await Promise.race([
      query.getContextUsage(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), claudeContextUsageTimeoutMs)
      }),
    ]))
    return {
      contextTokens: report?.totalTokens,
      contextWindowTokens: report?.rawMaxTokens,
    }
  } catch {
    return {}
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function claudeTodoSteps(value: unknown): AgentWorkingPlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: AgentWorkingPlanStep[] = []
  for (const candidate of value) {
    const todo = asRecord(candidate)
    if (!todo || typeof todo.content !== "string") return undefined
    const status = todo.status === "in_progress" ? "in-progress" : todo.status
    if (status !== "pending" && status !== "in-progress" && status !== "completed") {
      return undefined
    }
    steps.push({ text: todo.content, status })
  }
  return steps
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

const defaultClaudeQueryFactory: ClaudeQueryFactory = (input, options) => {
  const resolved = resolveClaudeSdkExecutable(process.env.PATH ?? "", process.platform)
  if ("problem" in resolved) throw new Error(resolved.problem)
  return query({
    prompt: input satisfies AsyncIterable<SDKUserMessage>,
    options: { ...options, pathToClaudeCodeExecutable: resolved.executable } satisfies Options,
  })
}
