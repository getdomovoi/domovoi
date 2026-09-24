import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

import { buildVersion, type ApprovalDecision, type ProviderModel, type ProviderUsageLimits, type Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent, AgentWorkingPlanStep, ApprovalScope } from "./agents.js"
import { credentialStores } from "./credential-stores.js"
import { redactDurableText } from "./secret-redaction.js"
import { normalizeProviderUsage } from "./usage.js"

export type { AgentAdapter, AgentEvent } from "./agents.js"

export type JsonRpcMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface CodexTransport {
  send(message: JsonRpcMessage): void
  onMessage(listener: (message: JsonRpcMessage) => void): () => void
  onError?(listener: (error: Error) => void): () => void
  close(): Promise<void>
}

export type CodexPermissionProfile = "domovoi-read" | "domovoi-build"

export type CodexPolicy = {
  approvalPolicy: "on-request" | "never"
  permissions: CodexPermissionProfile
}

// Codex reads anywhere its sandbox allows without asking. Until a strict
// allow-list exists (it needs a survey of the toolchains commands load), both
// Domovoi profiles keep today's read access and refuse these credential
// stores. Every other read outside the worktree still runs without a card.
export const codexSecretLocations: readonly string[] = credentialStores.map(({ location }) => location)

// Secret files inside the worktree are refused too (owner ruling, 2026-09-22),
// in every mode. A test or build that loads one of them inside the sandbox
// fails with "Operation not permitted".
export const codexWorktreeSecretPatterns = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
] as const

// Codex emits no item for a command its sandbox refuses, so Domovoi cannot see
// the attempt. The person is told when a session reaches Codex, and the model
// is asked to say so itself when a command fails on one of these files.
const codexWorktreeSecretFiles = codexWorktreeSecretPatterns.map((pattern) => pattern.replace(/^\*\*\//, ""))

export const codexWorktreeSecretNotice = {
  body: "Codex cannot read secret files in this worktree.",
  detail: `The Codex sandbox refuses reads of ${codexWorktreeSecretFiles.slice(0, -1).join(", ")} and ${codexWorktreeSecretFiles.at(-1)} at any depth. A test or build that loads .env fails with "Operation not permitted". Codex does not report the refused read to Domovoi, so it shows only in the agent's reply.`,
} as const

// The notice names committed copies of those files too, which Codex can
// still read through Git, or says the history could not be checked.
export function codexSandboxNotice(committed: readonly string[] | undefined): { body: string; detail: string } {
  if (committed === undefined) {
    return {
      body: codexWorktreeSecretNotice.body,
      detail: `${codexWorktreeSecretNotice.detail} Domovoi could not finish checking the repository history.`,
    }
  }
  if (committed.length === 0) return codexWorktreeSecretNotice
  const list = committed.length === 1
    ? committed[0]!
    : `${committed.slice(0, -1).join(", ")} and ${committed.at(-1)!}`
  return {
    body: codexWorktreeSecretNotice.body,
    detail: `${codexWorktreeSecretNotice.detail} Codex can still read these through Git: ${list}.`,
  }
}

export const codexDeveloperInstructions = `Domovoi runs you in a sandbox that refuses reads of these files anywhere in the worktree: ${codexWorktreeSecretFiles.join(", ")}. A command that opens one of them fails with "Operation not permitted", for example a test or build that loads .env. Domovoi cannot see that failure. When a command fails on one of these files, say so in your reply and name the file.`

const codexSandboxContext = {
  "domovoi-sandbox": { kind: "application", value: codexDeveloperInstructions },
} as const

export function codexAppServerArguments(): string[] {
  const worktreeSecrets = `{${codexWorktreeSecretPatterns.map((pattern) => `${JSON.stringify(pattern)}="deny"`).join(",")}}`
  const denied = `{${[
    ...codexSecretLocations.map((location) => `${JSON.stringify(location)}="deny"`),
    `":workspace_roots"=${worktreeSecrets}`,
  ].join(",")}}`
  const profile = (name: CodexPermissionProfile, base: string) => [
    "-c", `permissions.${name}.extends=${JSON.stringify(base)}`,
    "-c", `permissions.${name}.filesystem=${denied}`,
    "-c", `permissions.${name}.network.enabled=false`,
  ]
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `default_permissions=${JSON.stringify(":workspace")}`,
    ...profile("domovoi-read", ":read-only"),
    ...profile("domovoi-build", ":workspace"),
  ]
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

const STDERR_TAIL_BYTES = 16_384

export function codexPolicyFor(runtime: Runtime): CodexPolicy {
  if (runtime.permissionMode === "ask") return { approvalPolicy: "on-request", permissions: "domovoi-read" }
  if (runtime.permissionMode === "plan") return { approvalPolicy: "never", permissions: "domovoi-read" }
  return {
    approvalPolicy: runtime.permissionMode === "build" && runtime.auto ? "never" : "on-request",
    permissions: "domovoi-build",
  }
}

export class StdioCodexTransport implements CodexTransport {
  #child: ChildProcessWithoutNullStreams
  #messageListeners = new Set<(message: JsonRpcMessage) => void>()
  #errorListeners = new Set<(error: Error) => void>()
  #closing = false
  #closed = false
  #failed = false
  #closePromise: Promise<void> | undefined
  #shutdownGraceMs: number

  constructor(childFactory: () => ChildProcessWithoutNullStreams = () => spawn(
    "codex",
    codexAppServerArguments(),
    { stdio: ["pipe", "pipe", "pipe"] },
  ), shutdownGraceMs = 2_000) {
    this.#child = childFactory()
    this.#shutdownGraceMs = shutdownGraceMs
    const stderrTail = captureStderrTail(this.#child.stderr)
    const lines = createInterface({ input: this.#child.stdout })
    lines.on("line", (line) => {
      try {
        const message = requireJsonRpcMessage(JSON.parse(line))
        for (const listener of this.#messageListeners) listener(message)
      } catch {
        this.#emitError(new Error("Codex app-server emitted invalid JSONL"))
      }
    })
    this.#child.on("error", (error) => this.#emitError(error))
    this.#child.stdin.on("error", (error) => this.#emitError(error))
    this.#child.stdout.on("error", (error) => this.#emitError(error))
    this.#child.stderr.on("error", (error) => this.#emitError(error))
    this.#child.once("exit", (code, signal) => {
      if (this.#closing) return
      const exit = code !== null
        ? `Codex app-server exited with code ${code}`
        : `Codex app-server exited from signal ${signal ?? "unknown"}`
      const stderr = redactDurableText(stderrTail()).value
      this.#emitError(new Error(stderr ? `${exit}: ${stderr}` : exit))
    })
    this.#child.once("close", () => {
      this.#closed = true
    })
  }

  send(message: JsonRpcMessage): void {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.#emitError(failure)
      throw failure
    }
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#messageListeners.add(listener)
    return () => this.#messageListeners.delete(listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener)
    return () => this.#errorListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#closePromise = new Promise<void>((resolve) => {
      let settled = false
      let forced: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forced) clearTimeout(forced)
        this.#child.off("close", finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (
          this.#closed
          || this.#child.exitCode !== null
          || this.#child.signalCode !== null
        ) {
          finish()
          return
        }
        this.#child.kill("SIGKILL")
        // A kill is a request to the kernel, not the exit itself. Waiting for
        // the real close keeps the caller from treating an app-server that
        // still holds its workspace open as stopped, and keeps a replacement
        // from starting alongside it.
        forced = setTimeout(finish, this.#shutdownGraceMs)
        forced.unref()
      }, this.#shutdownGraceMs)
      timer.unref()
      this.#child.once("close", finish)
      this.#child.kill("SIGTERM")
    })
    await this.#closePromise
  }

  #emitError(error: Error): void {
    if (this.#closing || this.#failed) return
    this.#failed = true
    for (const listener of this.#errorListeners) listener(error)
  }
}

// Codex runs a command inside its sandbox unless the request is to run outside
// it, which is what most approvals are. The sandbox is the one codexPolicyFor
// picks for the mode: read-only in Ask and Plan, workspace-write in Build, and
// both read the whole disk. Neither has network: workspace-write sets it off,
// and read-only's networkAccess defaults to false in the app-server schema.
export function codexApprovalScope(runtime: Runtime): ApprovalScope {
  const profile = codexPolicyFor(runtime).permissions
  return {
    command: profile === "domovoi-read"
      ? "Reads anything this user account can read except credential stores and secret files, and writes nothing while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can."
      : "Writes only in the session worktree and reads anything this user account can read except credential stores and secret files while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can.",
    network: "None inside the Codex sandbox. A request to run outside the sandbox has this machine's network access.",
  }
}

export class CodexAppServerAdapter implements AgentAdapter {
  approvalScope(runtime: Runtime): ApprovalScope { return codexApprovalScope(runtime) }
  readonly permissionCapabilities = { ask: "read-only", buildAuto: "unsupported" } as const
  #transportFactory: () => CodexTransport
  #transport: CodexTransport | undefined
  #nextId = 0
  #pending = new Map<number, PendingRequest>()
  #eventListeners = new Set<(event: AgentEvent) => void>()
  #unsubscribeMessage: (() => void) | undefined
  #unsubscribeError: (() => void) | undefined
  #connectPromise: Promise<void> | undefined
  #collaborationModeAvailable = true
  #additionalContextAvailable = true

  constructor(transportFactory: () => CodexTransport = () => new StdioCodexTransport()) {
    this.#transportFactory = transportFactory
  }

  async connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise
    if (this.#transport) return
    const connecting = this.#openTransport()
    this.#connectPromise = connecting
    try {
      await connecting
    } finally {
      if (this.#connectPromise === connecting) this.#connectPromise = undefined
    }
  }

  async resetConnection(): Promise<void> {
    const transport = this.#transport
    this.#connectPromise = undefined
    if (transport) this.#detachTransport(transport)
    this.#rejectPending(new Error("Codex connection reset"))
    await transport?.close()
  }

  async startThread({ cwd, runtime }: { cwd: string; runtime: Runtime }): Promise<string> {
    const policy = codexPolicyFor(runtime)
    const sandbox = policy.permissions === "domovoi-read" ? "read-only" : "workspace-write"
    // thread/start developerInstructions replaces the person's own
    // developer_instructions rather than adding to them, so Domovoi reads the
    // value Codex resolved for this worktree and sends both.
    const own = resolvedDeveloperInstructions(await this.#request("config/read", { cwd }))
    const result = await this.#request("thread/start", {
      cwd,
      model: runtime.model,
      approvalPolicy: policy.approvalPolicy,
      sandbox,
      serviceName: "domovoi",
      developerInstructions: own ? `${own}\n\n${codexDeveloperInstructions}` : codexDeveloperInstructions,
    })
    const threadId = nestedId(result, "thread")
    if (!threadId) throw new Error("Codex did not return a thread id")
    return threadId
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const models: ProviderModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let pageCount = 0
    do {
      if (cursor) {
        if (seenCursors.has(cursor)) break
        seenCursors.add(cursor)
      }
      if (pageCount >= 50) break
      pageCount += 1
      const page = requireModelPage(await this.#request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, signal))
      for (const candidate of page.data) {
        const id = candidate.id
        if (!id || candidate.hidden) continue
        const displayName = candidate.displayName?.trim() || id
        const supportedReasoningEfforts = (candidate.supportedReasoningEfforts ?? [])
          .map((effort) => effort.trim())
          .filter((effort) => effort.length > 0)
        const requestedDefault = candidate.defaultReasoningEffort?.trim()
        const defaultReasoningEffort = requestedDefault
          ? requestedDefault
          : supportedReasoningEfforts[0] ?? "medium"
        if (
          supportedReasoningEfforts.length > 0
          && !supportedReasoningEfforts.includes(defaultReasoningEffort)
        ) {
          supportedReasoningEfforts.unshift(defaultReasoningEffort)
        }
        models.push({
          provider: "codex",
          id,
          displayName,
          description: candidate.description ?? "",
          supportedReasoningEfforts,
          defaultReasoningEffort,
          isDefault: candidate.isDefault ?? false,
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return models
  }

  async usageLimits(signal?: AbortSignal): Promise<ProviderUsageLimits | undefined> {
    return parseCodexUsageLimits(await this.#request(
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      signal,
    ))
  }

  async stopThread(threadId: string): Promise<void> {
    await this.#request("thread/archive", { threadId })
  }

  async resumeThread({ threadId }: {
    threadId: string
    cwd: string
    runtime: Runtime
  }): Promise<void> {
    const result = await this.#request("thread/resume", { threadId })
    if (nestedId(result, "thread") !== threadId) {
      throw new Error("Codex did not resume the requested thread")
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId })
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const result = await this.#request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt }],
    })
    if (asRecord(result)?.turnId !== turnId) throw new Error("Codex steered a different turn")
  }

  async startTurn({
    threadId,
    cwd,
    prompt,
    runtime,
  }: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string> {
    const policy = codexPolicyFor(runtime)
    const params = {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      model: runtime.model,
      effort: runtime.reasoning,
      ...policy,
    }
    const collaborationMode = {
      mode: runtime.permissionMode === "plan" ? "plan" : "default",
      settings: {
        model: runtime.model,
        reasoning_effort: runtime.reasoning,
        developer_instructions: null,
      },
    }
    // Thread developer instructions reach the model only when the thread
    // starts, so a thread started before Domovoi sent them, then resumed,
    // would never learn which files the sandbox refuses. Every turn carries
    // the same text as context, which Codex keeps once per source key. A
    // Codex without the field gets the rest of the turn unchanged.
    let result: unknown
    for (;;) {
      const withCollaboration = this.#collaborationModeAvailable
      const withContext = this.#additionalContextAvailable
      try {
        result = await this.#request("turn/start", {
          ...params,
          ...(withCollaboration ? { collaborationMode } : {}),
          ...(withContext ? { additionalContext: codexSandboxContext } : {}),
        })
        break
      } catch (error) {
        if (withContext && additionalContextUnavailable(error)) {
          this.#additionalContextAvailable = false
          continue
        }
        if (withCollaboration && collaborationModeUnavailable(error)) {
          this.#collaborationModeAvailable = false
          continue
        }
        throw error
      }
    }
    const turnId = nestedId(result, "turn")
    if (!turnId) throw new Error("Codex did not return a turn id")
    return turnId
  }

  resolveApproval(
    requestId: number,
    decision: ApprovalDecision,
  ): void {
    const mapped = decision === "allow-once" || decision === "always-project"
      ? "accept"
      : "decline"
    this.#transport?.send({ id: requestId, result: { decision: mapped } })
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  async close(): Promise<void> {
    const transport = this.#transport
    if (transport) this.#detachTransport(transport)
    this.#rejectPending(new Error("Codex adapter closed"))
    await transport?.close()
  }

  #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const transport = this.#transport
    if (!transport) return Promise.reject(new Error("Codex adapter is not connected"))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id)
        reject(signal!.reason)
      }
      const cleanup = () => signal?.removeEventListener("abort", abort)
      signal?.addEventListener("abort", abort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      })
      try {
        transport.send({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #openTransport(): Promise<void> {
    const transport = this.#transportFactory()
    this.#transport = transport
    this.#collaborationModeAvailable = true
    this.#additionalContextAvailable = true
    this.#unsubscribeMessage = transport.onMessage((message) => {
      if (this.#transport === transport) this.#receive(message)
    })
    this.#unsubscribeError = transport.onError?.((error) => {
      this.#handleTransportFailure(transport, error)
    })
    try {
      const clientInfo = { name: "domovoi", title: "Domovoi", version: buildVersion }
      try {
        await this.#request("initialize", {
          clientInfo,
          capabilities: { experimentalApi: true },
        })
      } catch (error) {
        if (!collaborationModeUnavailable(error)) throw error
        this.#collaborationModeAvailable = false
        await this.#request("initialize", { clientInfo })
      }
      if (this.#transport !== transport) {
        throw new Error("Codex transport disconnected during initialization")
      }
      transport.send({ method: "initialized", params: {} })
    } catch (error) {
      if (this.#transport === transport) {
        this.#detachTransport(transport)
        this.#rejectPending(error instanceof Error ? error : new Error(String(error)))
        await transport.close().catch(() => undefined)
      }
      throw error
    }
  }

  #handleTransportFailure(transport: CodexTransport, error: Error): void {
    if (this.#transport !== transport) return
    this.#detachTransport(transport)
    this.#rejectPending(error)
    this.#emit({ type: "provider-disconnected", reason: error.message })
    void transport.close().catch(() => undefined)
  }

  #detachTransport(transport: CodexTransport): void {
    if (this.#transport !== transport) return
    this.#unsubscribeMessage?.()
    this.#unsubscribeError?.()
    this.#unsubscribeMessage = undefined
    this.#unsubscribeError = undefined
    this.#transport = undefined
  }

  #receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"))
      else pending.resolve(message.result)
      return
    }

    const params = message.params ?? {}
    const common = {
      ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
    }
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.#emit({
        type: "text-delta",
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        delta: params.delta,
      })
    } else if (message.method === "item/plan/delta" && typeof params.delta === "string") {
      this.#emit({ type: "plan-delta", ...common, delta: params.delta })
    } else if (message.method === "turn/plan/updated" && typeof params.threadId === "string") {
      const steps = codexPlanSteps(params.plan)
      if (steps) this.#emit({ type: "plan-updated", ...common, threadId: params.threadId, steps })
    } else if (
      message.method === "item/commandExecution/outputDelta" &&
      typeof params.delta === "string"
    ) {
      this.#emit({
        type: "command-output",
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        delta: params.delta,
      })
    } else if (message.method === "turn/diff/updated" && typeof params.diff === "string") {
      this.#emit({ type: "diff-updated", ...common, diff: params.diff })
    } else if (
      message.method === "item/commandExecution/requestApproval" &&
      message.id !== undefined
    ) {
      this.#emit({
        type: "approval-requested",
        requestId: message.id,
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        ...(typeof params.command === "string" ? { command: params.command } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      })
    } else if (message.method === "item/started" || message.method === "item/completed") {
      this.#emit({
        type: "item",
        phase: message.method === "item/started" ? "started" : "completed",
        params,
      })
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params.tokenUsage)
      const last = asRecord(tokenUsage?.last)
      // Codex defines last.totalTokens as current context. tokenUsage.total is
      // cumulative session usage and must never drive context occupancy.
      const usage = last ? normalizeProviderUsage({
        usage: last,
        contextTokens: last.totalTokens,
        contextWindowTokens: tokenUsage?.modelContextWindow,
      }) : undefined
      if (usage && typeof params.threadId === "string" && typeof params.turnId === "string") {
        this.#emit({ type: "usage", threadId: params.threadId, turnId: params.turnId, usage })
      }
    } else if (message.method === "turn/completed") {
      const usage = normalizeProviderUsage(params.turn ?? params)
      if (usage && typeof params.threadId === "string" && typeof params.turnId === "string") {
        this.#emit({ type: "usage", threadId: params.threadId, turnId: params.turnId, usage })
      }
      this.#emit({ type: "turn-completed", params })
    }
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#eventListeners) listener(event)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function resolvedDeveloperInstructions(result: unknown): string | undefined {
  const instructions = asRecord(asRecord(result)?.config)?.developer_instructions
  return typeof instructions === "string" && instructions.trim() ? instructions.trim() : undefined
}

function additionalContextUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /additionalContext/iu.test(message)
}

function collaborationModeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /collaborationMode|experimentalApi/iu.test(message)
}

function captureStderrTail(stream: Readable): () => string {
  let tail = Buffer.alloc(0)
  stream.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
  })
  return () => tail.toString("utf8").trim()
}

type CodexModel = {
  id: string | null | undefined
  displayName: string | null | undefined
  description: string | null | undefined
  hidden: boolean | null | undefined
  supportedReasoningEfforts: string[] | null | undefined
  defaultReasoningEffort: string | null | undefined
  isDefault: boolean | null | undefined
}

type CodexModelPage = {
  data: CodexModel[]
  nextCursor: string | null
}

function requireJsonRpcMessage(value: unknown): JsonRpcMessage {
  const message = asRecord(value)
  if (!message) throw new Error("Codex app-server emitted invalid JSONL")
  const params = asRecord(message.params)
  const error = asRecord(message.error)
  return {
    ...(typeof message.id === "number" ? { id: message.id } : {}),
    ...(typeof message.method === "string" ? { method: message.method } : {}),
    ...(params ? { params } : {}),
    ...("result" in message ? { result: message.result } : {}),
    ...(isNullish(message.error)
      ? {}
      : {
          error: {
            ...(typeof error?.code === "number" ? { code: error.code } : {}),
            ...(typeof error?.message === "string" ? { message: error.message } : {}),
          },
        }),
  }
}

function requireModelPage(value: unknown): CodexModelPage {
  const page = asRecord(value)
  if (
    !page
    || (!isNullish(page.data) && !Array.isArray(page.data))
    || !isOptionalString(page.nextCursor)
  ) throw new Error("Codex did not return a model list")
  const data: CodexModel[] = []
  for (const candidate of page.data ?? []) {
    const model = parseCodexModel(candidate)
    if (model) data.push(model)
  }
  return { data, nextCursor: page.nextCursor ?? null }
}

function parseCodexUsageLimits(value: unknown): ProviderUsageLimits | undefined {
  const rateLimits = asRecord(asRecord(value)?.rateLimits)
  if (!rateLimits) return undefined
  const windows = (["primary", "secondary"] as const).flatMap((kind) => {
    const window = asRecord(rateLimits[kind])
    if (!window) return []
    const usedPercent = window.usedPercent
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      return []
    }
    const duration = window.windowDurationMins
    if (!isNullish(duration) && (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0)) {
      return []
    }
    const resetSeconds = window.resetsAt
    if (!isNullish(resetSeconds) && (typeof resetSeconds !== "number" || !Number.isFinite(resetSeconds) || resetSeconds < 0)) {
      return []
    }
    return [{
      kind,
      usedPercent,
      ...(typeof duration === "number" ? { windowDurationMinutes: duration } : {}),
      ...(typeof resetSeconds === "number" ? { resetsAt: new Date(resetSeconds * 1_000).toISOString() } : {}),
    }]
  })
  if (windows.length === 0) return undefined
  return {
    provider: "codex",
    ...(typeof rateLimits.planType === "string" && rateLimits.planType.trim()
      ? { planType: rateLimits.planType }
      : {}),
    windows,
  }
}

function parseCodexModel(value: unknown): CodexModel | undefined {
  const model = asRecord(value)
  const supportedReasoningEfforts = isNullish(model?.supportedReasoningEfforts)
    ? undefined
    : parseReasoningEfforts(model.supportedReasoningEfforts)
  if (
    !model
    || !isOptionalString(model.id)
    || !isOptionalString(model.model)
    || !isOptionalString(model.displayName)
    || !isOptionalString(model.description)
    || !isOptionalBoolean(model.hidden)
    || (!isNullish(model.supportedReasoningEfforts) && !supportedReasoningEfforts)
    || !isOptionalString(model.defaultReasoningEffort)
    || !isOptionalBoolean(model.isDefault)
  ) return undefined
  return {
    id: model.model ?? model.id,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  }
}

function parseReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const efforts: string[] = []
  for (const candidate of value) {
    const option = asRecord(candidate)
    if (!option) return undefined
    if (typeof option.reasoningEffort === "string") efforts.push(option.reasoningEffort)
  }
  return efforts
}

function codexPlanSteps(value: unknown): AgentWorkingPlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: AgentWorkingPlanStep[] = []
  for (const candidate of value) {
    const entry = asRecord(candidate)
    if (!entry || typeof entry.step !== "string") return undefined
    const status = entry.status === "inProgress" ? "in-progress" : entry.status
    if (status !== "pending" && status !== "in-progress" && status !== "completed") {
      return undefined
    }
    steps.push({ text: entry.step, status })
  }
  return steps
}

function nestedId(value: unknown, key: "thread" | "turn"): string | undefined {
  const id = asRecord(asRecord(value)?.[key])?.id
  return typeof id === "string" ? id : undefined
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return isNullish(value) || typeof value === "string"
}

function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return isNullish(value) || typeof value === "boolean"
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
