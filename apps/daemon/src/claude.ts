import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"

import {
  query,
  type Options,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import {
  ApprovalRequestNotPendingError,
  type AgentAdapter,
  type AgentEvent,
  type AgentRepositoryTrust,
  type AgentVisualContext,
  type AgentWorkingPlanStep,
} from "./agents.js"
import {
  claudeRepositoryLoad,
  claudeToolServerName,
  withoutOwnServers,
  type ClaudeRepositoryLoad,
  type ClaudeRepositoryServer,
  type ClaudeRepositorySettings,
} from "./claude-repository-trust.js"
import { repositoryTrustVerdict } from "./repository-trust-apply.js"
import type { RepositoryProviderConfigReader } from "./tool-inventory.js"
import { projectInstructions } from "./project-instructions.js"
import { claudeReadOutsideWorktree, claudeShellReadIsListed, isClaudeReadTool } from "./claude-read-scope.js"
import { gitReadCanRunProgram } from "./git-read-config.js"
import { permissionDecisionFor } from "./permission-policy.js"
import { DurableOutputRedactor, redactDurableText } from "./secret-redaction.js"
import { checkClaudeInstall, resolveClaudeSdkExecutable } from "./claude-install.js"
import {
  spawnClaudeProcess,
  stopClaudeProcess,
  type ClaudeProcess,
  type ClaudeProcessOptions,
} from "./claude-process.js"
import { normalizeProviderUsage } from "./usage.js"

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const
const maximumClaudeStderrBytes = 16_384
const claudeFileTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
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
  env?: NodeJS.ProcessEnv
  sessionId?: string
  resume?: string
  model?: string
  effort?: typeof claudeEfforts[number]
  permissionMode?: ClaudePermissionMode
  allowDangerouslySkipPermissions?: boolean
  includePartialMessages?: boolean
  forwardSubagentText?: boolean
  settingSources?: Array<"user" | "project" | "local">
  // Claude's flag layer: only a trusted repository's loadable settings.
  settings?: ClaudeRepositorySettings
  tools?: string[]
  disallowedTools?: string[]
  systemPrompt?: { type: "preset"; preset: "claude_code"; append?: string }
  hooks?: { PreToolUse?: Array<{ hooks: ClaudePreToolUseHook[] }> }
  stderr?: (data: string) => void
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess
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
  // Every server Claude loaded, in each scope, and adding servers of its own.
  mcpServerStatus(): Promise<Array<{ name: string }>>
  setMcpServers(servers: Record<string, ClaudeRepositoryServer>): Promise<unknown>
  interrupt(): Promise<unknown>
  close(): void
}

export type ClaudeQueryFactory = (
  input: AsyncIterable<ClaudeUserMessage>,
  options: ClaudeQueryOptions,
) => ClaudeQuery

type ClaudeTask = { subject: string; status: "pending" | "in_progress" | "completed" }
type ClaudeTaskTool = {
  type: "task"
  name: "TaskCreate" | "TaskUpdate" | "TaskList"
  input: Record<string, unknown>
}

type Session = {
  threadId: string
  cwd: string
  input: PushStream<ClaudeUserMessage>
  query: ClaudeQuery
  runtime: Runtime
  tools: Map<string, { type: "command"; command: string } | { type: "file"; path: string } | ClaudeTaskTool>
  tasks: Map<string, ClaudeTask>
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
  // The Claude processes this session's query started, normally one. A stop
  // is complete only when every one of them has exited.
  processes: ClaudeProcess[]
  stop?: Promise<void>
  // The digest of the trusted configuration this session's Claude was given
  // part of, set only when some of it reached Claude.
  repositoryTrustApplied?: { digest: string }
  // Every server Claude runs for this session, the person's own and the
  // repository's it was given, set only when it was given some: a card names
  // a tool's server from these (claudeToolServerName).
  toolServers?: readonly string[]
}

// A query Domovoi started Claude for: a session's, or a model list's, which
// has no thread.
type OwnedQuery = Pick<Session, "input" | "query" | "processes" | "stop"> & { threadId?: string }

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
  readonly #processOptions: ClaudeProcessOptions
  readonly #readRepositoryConfig: RepositoryProviderConfigReader | undefined
  #sessions = new Map<string, Session>()
  // Stopped queries whose Claude process has not exited yet. A retried stop,
  // a reopen and a shutdown wait on these instead of finding nothing to stop.
  #stopping = new Set<OwnedQuery>()
  // Set when close begins, before it waits on anything. No Claude process is
  // started while it is set.
  #closing = false
  // Set for good once a close has succeeded: nothing reopens the adapter.
  #closed = false
  // Closes run one at a time, each after the one before it has settled, and
  // a close that fails reopens the adapter only when no other close waits:
  // one close's failure never undoes another's success (review round 2 of
  // #647, R2-F3).
  #closeQueue: Promise<void> = Promise.resolve()
  #closesWaiting = 0
  // Model lists from the moment their query exists, finished or not. Close
  // stops each one and waits for its Claude (R2-F4).
  #discoveries = new Set<OwnedQuery>()
  // Starts still in their install check or instruction read, which close
  // waits for: each refuses to start Claude once it resumes.
  #preparing = new Set<Promise<unknown>>()
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
    processOptions: ClaudeProcessOptions = {},
    // How a session's worktree configuration is read for its trust verdict;
    // the repository reader unless a test gives another.
    readRepositoryConfig?: RepositoryProviderConfigReader,
  ) {
    this.#factory = factory
    this.#id = id
    this.#preflight = preflight
    this.#processOptions = processOptions
    this.#readRepositoryConfig = readRepositoryConfig
  }

  async connect(): Promise<void> {}

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    signal?.throwIfAborted()
    this.#refuseWhenClosing()
    if (this.#preflight) {
      await this.#prepared(this.#preflight())
      signal?.throwIfAborted()
    }
    this.#refuseWhenClosing()
    const input = new PushStream<ClaudeUserMessage>()
    const stderr = new ClaudeStderrTail()
    // The model list's Claude is started and stopped like a session's, so a
    // shutdown waits for it too, whether the list succeeds, fails or is
    // cancelled.
    const processes: ClaudeProcess[] = []
    const runtime = this.#factory(input, {
      ...baseOptions(),
      settingSources: [],
      stderr: (data) => stderr.push(data),
      spawnClaudeCodeProcess: (spawnOptions) => this.#spawn(spawnOptions, input, stderr, processes),
    })
    const discovery: OwnedQuery = { input, query: runtime, processes }
    this.#discoveries.add(discovery)
    const close = () => {
      void this.#stopSession(discovery).then(() => this.#discoveries.delete(discovery), () => {})
    }
    signal?.addEventListener("abort", close, { once: true })
    try {
      await runtime.initializationResult()
      signal?.throwIfAborted()
      const models = requireClaudeModels(await runtime.supportedModels())
      signal?.throwIfAborted()
      return models.map((model, index) => {
        const efforts = model.supportsEffort
          ? ["unset", ...(model.supportedEffortLevels ?? [])]
          : []
        return {
          provider: "claude-code",
          id: model.value,
          displayName: model.displayName,
          description: model.description,
          supportedReasoningEfforts: efforts,
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

  // Each open, whether a start, a resume or a reopen, decides from the grant
  // it is given what the repository may load (#openSession). A session
  // already open keeps what it loaded (ruling Q143 A).
  async startThread({ cwd, runtime, repositoryTrust }: Parameters<AgentAdapter["startThread"]>[0]): Promise<string> {
    const threadId = this.#id()
    await this.#openSession(threadId, cwd, runtime, false, repositoryTrust)
    return threadId
  }

  async resumeThread({ threadId, cwd, runtime, repositoryTrust }: Parameters<AgentAdapter["resumeThread"]>[0]): Promise<void> {
    // A conversation whose last process still runs is not reopened beside
    // it, and a loaded one is not reported ready while it does.
    await this.#stopped(threadId)
    if (this.#sessions.has(threadId)) return
    await this.#openSession(threadId, cwd, runtime, true, repositoryTrust)
  }

  async startTurn({ threadId, prompt, runtime, visualContexts, repositoryTrust }: Parameters<AgentAdapter["startTurn"]>[0]): Promise<string> {
    let session = this.#requireSession(threadId)
    // A mode change no longer restarts anything: the tool boundary moved to
    // #requestApproval, and Claude's own mode is applied live by #applyRuntime
    // below. Only a session that has ended needs reopening.
    if (session.ended) {
      const previous = session
      // The ended query's process, and that of any earlier reopen that
      // failed, must be gone before a new one resumes the same conversation
      // in the same worktree.
      await this.#stopSession(previous)
      await this.#stopped(threadId)
      this.#sessions.delete(threadId)
      try {
        // Resume only a conversation that exists. Moving the mode before the
        // first turn used to ask Claude to resume a session it had never
        // opened, which failed with "No conversation found".
        await this.#openSession(threadId, previous.cwd, runtime, previous.started === true, repositoryTrust)
      } catch (error) {
        // Put back the ended session, so a later send reopens the
        // conversation instead of finding nothing loaded, which hid the real
        // cause. It is never used as it is: being ended, every send reopens,
        // and a reopen first waits for the failed query's process to exit.
        if (!this.#sessions.has(threadId)) this.#sessions.set(threadId, previous)
        throw error
      }
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

  // Resolves once Claude has exited, and rejects while it still runs after the
  // kill: the caller then keeps the thread fenced and the profile lease held.
  async stopThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId)
    if (session) {
      this.#sessions.delete(threadId)
      void this.#stopSession(session)
    }
    await this.#stopped(threadId)
  }

  resolveApproval(requestId: number, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) throw new ApprovalRequestNotPendingError(requestId)
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

  // Resolves once every Claude process the adapter started, and everything
  // it started, is gone. From the call on no process is started. A close
  // that fails leaves the adapter open, as a failed stop leaves its thread:
  // once the process has exited, the thread can be stopped, reopened and
  // closed again. A close that succeeds closes the adapter for good.
  async close(): Promise<void> {
    this.#closing = true
    this.#closesWaiting += 1
    const previous = this.#closeQueue
    let settled!: () => void
    this.#closeQueue = new Promise((resolve) => { settled = resolve })
    try {
      await previous
      if (this.#closed) return
      await this.#closeOnce()
      this.#closed = true
    } catch (error) {
      if (this.#closesWaiting === 1 && !this.#closed) this.#closing = false
      throw error
    } finally {
      this.#closesWaiting -= 1
      settled()
    }
  }

  async #closeOnce(): Promise<void> {
    for (const session of this.#sessions.values()) void this.#stopSession(session)
    this.#sessions.clear()
    for (const discovery of this.#discoveries) {
      void this.#stopSession(discovery).then(() => this.#discoveries.delete(discovery), () => {})
    }
    for (const pending of this.#pendingApprovals.values()) {
      pending.resolve({ behavior: "deny", message: "Domovoi closed the Claude session" })
    }
    this.#pendingApprovals.clear()
    // A start still preparing refuses once it resumes. Whatever a start
    // began before close is a session above, or stopping.
    await Promise.allSettled([...this.#preparing])
    await this.#stopped()
  }

  #refuseWhenClosing(): void {
    if (this.#closing) throw new Error("Claude adapter is closed")
  }

  // Tracks a start's preparation, so that close can wait for it.
  async #prepared<T>(preparation: Promise<T>): Promise<T> {
    this.#preparing.add(preparation)
    try {
      return await preparation
    } finally {
      this.#preparing.delete(preparation)
    }
  }

  // The spawnClaudeCodeProcess option: starts Claude, and tracks it, unless
  // the adapter is closing or the query's stop has begun, which refuses its
  // input first.
  #spawn(
    spawnOptions: SpawnOptions,
    input: PushStream<ClaudeUserMessage>,
    stderr: ClaudeStderrTail,
    processes: ClaudeProcess[],
    session?: string,
  ): SpawnedProcess {
    this.#refuseWhenClosing()
    if (input.closed) throw new Error("Claude query was stopped before its process started")
    const child = spawnClaudeProcess(spawnOptions, (data) => stderr.push(data), this.#processOptions, session)
    processes.push(child)
    return child.spawned
  }

  // Closes the query's input and the query, and waits for its processes, as
  // stopClaudeProcess does. The stop is made once per query: every later
  // caller waits on the same exit. Once every process has exited, even after
  // a stop that already failed, the query is stopped.
  #stopSession(session: OwnedQuery): Promise<void> {
    if (session.stop) {
      return session.processes.every((child) => child.hasExited()) ? Promise.resolve() : session.stop
    }
    // From here the input takes no message and starts no process. It closes
    // when stopClaudeProcess says: on Windows only after the tree kill (Q106).
    session.input.refuse()
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      session.input.close()
      session.query.close()
    }
    const running = session.processes.filter((child) => !child.hasExited())
    if (running.length === 0) close()
    const stop = Promise.all(running.map((child) => stopClaudeProcess(child, close, this.#processOptions)))
      .then(() => {})
    // Callers observe the failure; the promise is kept for the next one.
    stop.catch(() => {})
    session.stop = stop
    if (running.length > 0) {
      this.#stopping.add(session)
      void Promise.all(running.map((child) => child.exited)).then(() => {
        this.#stopping.delete(session)
      })
    }
    return stop
  }

  // Waits for the stops of one thread's sessions, or of every session.
  async #stopped(threadId?: string): Promise<void> {
    const stops = [...this.#stopping]
      .filter((session) => threadId === undefined || session.threadId === threadId)
      .map((session) => this.#stopSession(session))
    await Promise.all(stops)
  }

  async #openSession(
    threadId: string,
    cwd: string,
    runtime: Runtime,
    resume: boolean,
    repositoryTrust: AgentRepositoryTrust | undefined,
  ): Promise<void> {
    // A start that close overtook while it prepared starts no Claude.
    this.#refuseWhenClosing()
    const preflight = this.#preflight
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }
    const { instructions, repository, tasks } = await this.#prepared((async () => {
      if (preflight) await preflight()
      const instructions = await projectInstructions(cwd, "claude")
      // The worktree's verdict, read just before Claude starts: only a
      // trusted one brings anything, and it brings the documents its digest
      // was computed from. An archive resume is given no grant (Q149 A).
      const verdict = await repositoryTrustVerdict(cwd, repositoryTrust, this.#readRepositoryConfig)
      return {
        instructions,
        repository: verdict.state === "trusted" ? { digest: verdict.configDigest, ...claudeRepositoryLoad(verdict.documents) } : undefined,
        tasks: resume || env.CLAUDE_CODE_TASK_LIST_ID ? await readClaudeTasks(threadId, env) : new Map<string, ClaudeTask>(),
      }
    })())
    const settings = repository && Object.keys(repository.settings).length > 0 ? repository.settings : undefined
    this.#refuseWhenClosing()
    const input = new PushStream<ClaudeUserMessage>()
    const stderr = new ClaudeStderrTail()
    const permission = claudePermissionFor(runtime)
    // Domovoi starts the process itself so that a stop can wait for it to
    // exit, and kill it with its tools when it will not.
    const processes: ClaudeProcess[] = []
    const options: ClaudeQueryOptions = {
      ...baseOptions(),
      // Claude Code 2.1.292 offers its task tools (TaskCreate, TaskUpdate,
      // TaskList), and so a working plan, to a current model only with this
      // variable set. The SDK's env replaces the process environment.
      env,
      ...(instructions
        ? { systemPrompt: { type: "preset", preset: "claude_code", append: instructions } }
        : {}),
      cwd,
      ...(settings ? { settings } : {}),
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      model: runtime.model,
      ...(runtime.reasoning === "unset" ? {} : { effort: claudeEffortFor(runtime.reasoning) }),
      permissionMode: permission.permissionMode,
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      canUseTool: (toolName, toolInput, context) =>
        this.#requestApproval(threadId, cwd, toolName, toolInput, context),
      hooks: {
        PreToolUse: [{ hooks: [(hookInput) => this.#screenToolUse(threadId, cwd, hookInput)] }],
      },
      stderr: (data) => stderr.push(data),
      spawnClaudeCodeProcess: (spawnOptions) => this.#spawn(spawnOptions, input, stderr, processes, threadId),
    }
    const query = this.#factory(input, options)
    const session: Session = {
      threadId,
      cwd,
      input,
      query,
      runtime,
      tools: new Map(),
      tasks,
      screenedReads: new Map(),
      turnMessageIds: new Set(),
      interruptedMessageIds: new Set(),
      stderr,
      processes,
      ...(repository && settings ? { repositoryTrustApplied: { digest: repository.digest } } : {}),
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
      if (this.#sessions.get(threadId) === session) this.#sessions.delete(threadId)
      try {
        await this.#stopSession(session)
      } catch {
        // The start failure is the one to report. A process that outlived
        // the stop stays tracked, so a reopen and a shutdown still wait on it.
      }
      throw claudeFailureError(error, stderr.take())
    }
    // Close stopped this session while it started.
    this.#refuseWhenClosing()
    const toolServers = repository ? await this.#addRepositoryServers(query, repository.mcpServers) : undefined
    if (repository && toolServers) {
      session.repositoryTrustApplied = { digest: repository.digest }
      session.toolServers = toolServers
    }
  }

  // The digest of the trusted configuration an open session's Claude was
  // given part of, or undefined when it was given none: held back, or trusted
  // with nothing that loads. A session keeps it while it runs (Q143 A).
  repositoryTrustApplied(threadId: string): { digest: string } | undefined {
    return this.#sessions.get(threadId)?.repositoryTrustApplied
  }

  // A trusted repository's servers start with its session (ruling Q140 A).
  // Claude replaces a server with an added one of the same name, so the
  // person's own are listed first, from Claude, which knows every scope it
  // loaded, and a repository server named like one of them is held back
  // (Q150 A). A list that cannot be had adds none. Claude connects the rest
  // as it connects its own, without holding the open: the request is sent
  // before any turn, and a server that fails to connect fails alone. Gives
  // every server the session then runs, the person's and the added, or
  // undefined when none was handed to Claude.
  async #addRepositoryServers(query: ClaudeQuery, servers: ClaudeRepositoryLoad["mcpServers"]): Promise<string[] | undefined> {
    if (Object.keys(servers).length === 0) return undefined
    let own: string[]
    try {
      own = (await query.mcpServerStatus()).map(({ name }) => name)
    } catch {
      return undefined
    }
    const added = withoutOwnServers(servers, own)
    if (Object.keys(added).length === 0) return undefined
    query.setMcpServers(added).catch(() => {})
    return [...own, ...Object.keys(added)]
  }

  async #applyRuntime(session: Session, runtime: Runtime): Promise<void> {
    const permission = claudePermissionFor(runtime)
    await Promise.all([
      session.query.setModel(runtime.model),
      session.query.setPermissionMode(permission.permissionMode),
      // The SDK requires null to clear a prior effort; undefined leaves it set.
      session.query.applyFlagSettings({ effortLevel: runtime.reasoning === "unset" ? null : claudeEffortFor(runtime.reasoning) }),
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
    // A file tool is named by the tool Claude runs, never by a command field
    // in its input, so an Edit cannot pass for a shell command.
    const command = !claudeFileTools.has(toolName) && typeof input.command === "string" ? input.command : toolName
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
    // The file exactly as the provider will use it: not trimmed, and a
    // relative path is joined to cwd without collapsing "..", so the daemon
    // fingerprints the same file that runs. Bash acts on no file field, so a
    // file_path beside its command is never sent.
    const filePath = toolName === "Bash"
      ? undefined
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string" ? input.notebook_path : screened?.path
    // Claude names a tool server's tool mcp__<server>__<tool> and splits it at
    // the first separator after the server. The server is named as Claude
    // names it: Claude, not Domovoi, read the file that declared it. A
    // session given repository servers names only a server it knows the tool
    // belongs to, so a repository server can never pass for one of the
    // person's (security review round 1 of #671); the card still names the
    // provider tool when it names no server.
    const [prefix, split] = toolName.split("__")
    const server = prefix !== "mcp" ? undefined
      : session.toolServers ? claudeToolServerName(toolName, session.toolServers) : split
    this.#emit({
      type: "approval-requested",
      requestId,
      threadId,
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      itemId: context.toolUseID,
      command,
      // The request runs in the thread's directory. The path Claude blocked
      // on is named beside it and is never the directory a card shows.
      cwd,
      ...(filePath ? { path: isAbsolute(filePath) ? filePath : `${cwd}${sep}${filePath}` } : {}),
      ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}),
      ...(reason ? { reason } : {}),
      ...(toolName !== "Bash" && !claudeFileTools.has(toolName) ? { tool: toolName } : {}),
      ...(server ? { toolServer: { name: server } } : {}),
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
        if (steps && session.runtime.permissionMode !== "plan") {
          this.#emit({
            type: "plan-updated",
            threadId: session.threadId,
            turnId,
            steps,
          })
        }
        continue
      }
      if (block.name === "TaskCreate" || block.name === "TaskUpdate" || block.name === "TaskList") {
        // Task tools bypass canUseTool. Match their results by tool use id.
        session.tools.set(block.id, { type: "task", name: block.name, input })
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
      if (tracked.type === "task") {
        // Plan mode keeps the checklist, but the final reply supplies its proposal.
        if (!failed && updateClaudeTasks(session.tasks, tracked, rawToolResult) && session.runtime.permissionMode !== "plan") {
          this.#emit({
            type: "plan-updated",
            threadId: session.threadId,
            turnId,
            steps: [...session.tasks.values()].map(({ subject, status }) => ({
              text: subject,
              status: status === "in_progress" ? "in-progress" : status,
            })),
          })
        }
        continue
      }
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
  #ended = false

  get closed(): boolean {
    return this.#closed
  }

  push(value: T): void {
    if (this.#closed) throw new Error("Claude input stream is closed")
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  // Takes no more values, but does not end the stream yet: a Windows stop
  // ends it only after its tree kill (Q106).
  refuse(): void {
    this.#closed = true
  }

  close(): void {
    this.#closed = true
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift()
        if (value !== undefined) return { value, done: false }
        if (this.#ended) return { value: undefined, done: true }
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
    settingSources: ["user"],
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

function isClaudeTaskStatus(value: unknown): value is ClaudeTask["status"] {
  return value === "pending" || value === "in_progress" || value === "completed"
}

async function readClaudeTasks(threadId: string, env: NodeJS.ProcessEnv): Promise<Map<string, ClaudeTask>> {
  const tasks = new Map<string, ClaudeTask>()
  // Claude Code 2.1.292 keeps a session's tasks in its own storage, at
  // <config dir>/tasks/<list id>/<task id>.json, and takes an empty
  // CLAUDE_CODE_TASK_LIST_ID as unset. Read only, on resume or for a shared list.
  const listId = (env.CLAUDE_CODE_TASK_LIST_ID || threadId).replace(/[^a-zA-Z0-9_-]/g, "-")
  const directory = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "tasks", listId)
  try {
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .slice(0, 1000)
    for (const file of files) {
      try {
        const task = asRecord(JSON.parse(await readFile(join(directory, file), "utf8")))
        if (task && typeof task.id === "string" && typeof task.subject === "string" && isClaudeTaskStatus(task.status)) {
          tasks.set(task.id, { subject: task.subject, status: task.status })
        }
      } catch {
        // A missing or incomplete task file must not prevent the session opening.
      }
    }
  } catch {
    return tasks
  }
  return new Map([...tasks].sort(([left], [right]) => {
    if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) {
      const difference = BigInt(left) - BigInt(right)
      if (difference !== 0n) return difference < 0n ? -1 : 1
    }
    return left.localeCompare(right)
  }))
}

function updateClaudeTasks(tasks: Map<string, ClaudeTask>, tool: ClaudeTaskTool, rawResult: unknown): boolean {
  const result = asRecord(rawResult)
  if (!result) return false
  if (tool.name === "TaskCreate") {
    // The input has no task id. Only the top-level result supplies it.
    const task = asRecord(result.task)
    if (!task || typeof task.id !== "string" || typeof task.subject !== "string") return false
    const previous = tasks.get(task.id)
    if (previous?.subject === task.subject && previous.status === "pending") return false
    tasks.set(task.id, { subject: task.subject, status: "pending" })
    return true
  }
  if (tool.name === "TaskUpdate") {
    if (result.success !== true) return false
    const { subject, status } = tool.input
    // Claude repairs input aliases before running the tool. Its result names the task it updated.
    const taskId = [result.taskId, tool.input.taskId, tool.input.id, tool.input.task_id]
      .find((id) => typeof id === "string")
    if (typeof taskId !== "string") return false
    const previous = tasks.get(taskId)
    if (!previous) return false
    if (status === "deleted") return tasks.delete(taskId)
    const next: ClaudeTask = {
      subject: typeof subject === "string" ? subject : previous.subject,
      status: isClaudeTaskStatus(status) ? status : previous.status,
    }
    if (previous.subject === next.subject && previous.status === next.status) return false
    tasks.set(taskId, next)
    return true
  }
  if (!Array.isArray(result.tasks)) return false
  const listed = new Map<string, ClaudeTask>()
  for (const candidate of result.tasks) {
    const task = asRecord(candidate)
    if (!task || typeof task.id !== "string" || typeof task.subject !== "string" || !isClaudeTaskStatus(task.status)) return false
    listed.set(task.id, { subject: task.subject, status: task.status })
  }
  // TaskList restores the full ordered list, including after a session resume.
  tasks.clear()
  for (const [id, task] of listed) tasks.set(id, task)
  return true
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
