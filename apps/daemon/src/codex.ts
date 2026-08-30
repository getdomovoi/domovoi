import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
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

export type CodexPolicy = {
  approvalPolicy: "on-request" | "never"
  sandboxPolicy:
    | { type: "readOnly"; access: { type: "fullAccess" } }
    | {
        type: "workspaceWrite"
        writableRoots: string[]
        readOnlyAccess: { type: "fullAccess" }
        networkAccess: false
      }
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

export function codexPolicyFor(runtime: Runtime, cwd: string): CodexPolicy {
  if (runtime.permissionMode === "plan") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } },
    }
  }
  return {
    approvalPolicy: runtime.permissionMode === "build" && runtime.auto ? "never" : "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
    },
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
    ["app-server", "--listen", "stdio://"],
    { stdio: ["pipe", "pipe", "pipe"] },
  ), shutdownGraceMs = 2_000) {
    this.#child = childFactory()
    this.#shutdownGraceMs = shutdownGraceMs
    this.#child.stderr.resume()
    const lines = createInterface({ input: this.#child.stdout })
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as JsonRpcMessage
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
      const reason = code !== null
        ? `Codex app-server exited with code ${code}`
        : `Codex app-server exited from signal ${signal ?? "unknown"}`
      this.#emitError(new Error(reason))
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
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#child.off("close", finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (
          !this.#closed
          && this.#child.exitCode === null
          && this.#child.signalCode === null
        ) {
          this.#child.kill("SIGKILL")
        }
        finish()
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

export class CodexAppServerAdapter implements AgentAdapter {
  readonly permissionCapabilities = { buildAuto: "unsupported" } as const
  #transportFactory: () => CodexTransport
  #transport: CodexTransport | undefined
  #nextId = 0
  #pending = new Map<number, PendingRequest>()
  #eventListeners = new Set<(event: AgentEvent) => void>()
  #unsubscribeMessage: (() => void) | undefined
  #unsubscribeError: (() => void) | undefined
  #connectPromise: Promise<void> | undefined

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

  async startThread({ cwd, runtime }: { cwd: string; runtime: Runtime }): Promise<string> {
    const policy = codexPolicyFor(runtime, cwd)
    const sandbox = policy.sandboxPolicy.type === "readOnly" ? "read-only" : "workspace-write"
    const result = await this.#request("thread/start", {
      cwd,
      model: runtime.model,
      approvalPolicy: policy.approvalPolicy,
      sandbox,
      serviceName: "domovoi",
    }) as { thread?: { id?: string } }
    const threadId = result.thread?.id
    if (!threadId) throw new Error("Codex did not return a thread id")
    return threadId
  }

  async listModels(): Promise<ProviderModel[]> {
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
      const result = await this.#request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }) as {
        data?: Array<{
          id?: string
          model?: string
          displayName?: string
          description?: string
          hidden?: boolean
          supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>
          defaultReasoningEffort?: string
          isDefault?: boolean
        }>
        nextCursor?: string | null
      }
      for (const candidate of result.data ?? []) {
        const id = candidate.model ?? candidate.id
        if (!id || candidate.hidden) continue
        const displayName = candidate.displayName?.trim() || id
        const supportedReasoningEfforts = (candidate.supportedReasoningEfforts ?? [])
          .map((option) => option.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string")
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
      cursor = result.nextCursor ?? null
    } while (cursor)
    return models
  }

  async stopThread(threadId: string): Promise<void> {
    await this.#request("thread/archive", { threadId })
  }

  async resumeThread({ threadId }: {
    threadId: string
    cwd: string
    runtime: Runtime
  }): Promise<void> {
    const result = await this.#request("thread/resume", { threadId }) as {
      thread?: { id?: string }
    }
    if (result.thread?.id !== threadId) {
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
    }) as { turnId?: string }
    if (result.turnId !== turnId) throw new Error("Codex steered a different turn")
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
    const policy = codexPolicyFor(runtime, cwd)
    const result = await this.#request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      model: runtime.model,
      effort: runtime.reasoning,
      ...policy,
    }) as { turn?: { id?: string } }
    const turnId = result.turn?.id
    if (!turnId) throw new Error("Codex did not return a turn id")
    return turnId
  }

  resolveApproval(
    requestId: number,
    decision: ApprovalDecision,
  ): void {
    const mapped = decision === "allow-once"
      ? "accept"
      : decision === "always-project"
        ? "acceptForSession"
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

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const transport = this.#transport
    if (!transport) return Promise.reject(new Error("Codex adapter is not connected"))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        transport.send({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #openTransport(): Promise<void> {
    const transport = this.#transportFactory()
    this.#transport = transport
    this.#unsubscribeMessage = transport.onMessage((message) => {
      if (this.#transport === transport) this.#receive(message)
    })
    this.#unsubscribeError = transport.onError?.((error) => {
      this.#handleTransportFailure(transport, error)
    })
    try {
      await this.#request("initialize", {
        clientInfo: { name: "domovoi", title: "Domovoi", version: "0.0.1" },
      })
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
      this.#emit({ type: "text-delta", ...common, delta: params.delta })
    } else if (message.method === "item/plan/delta" && typeof params.delta === "string") {
      this.#emit({ type: "plan-delta", ...common, delta: params.delta })
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
