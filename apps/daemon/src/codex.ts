import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

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

export type AgentEvent =
  | { type: "text-delta"; threadId?: string; turnId?: string; delta: string }
  | { type: "plan-delta"; threadId?: string; turnId?: string; delta: string }
  | { type: "command-output"; threadId?: string; turnId?: string; itemId?: string; delta: string }
  | { type: "diff-updated"; threadId?: string; turnId?: string; diff: string }
  | {
      type: "approval-requested"
      requestId: number
      threadId?: string
      turnId?: string
      itemId?: string
      command?: string
      cwd?: string
      reason?: string
    }
  | { type: "item"; phase: "started" | "completed"; params: Record<string, unknown> }
  | { type: "turn-completed"; params: Record<string, unknown> }

export interface AgentAdapter {
  connect(): Promise<void>
  listModels(): Promise<ProviderModel[]>
  startThread(input: { cwd: string; runtime: Runtime }): Promise<string>
  stopThread(threadId: string): Promise<void>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  startTurn(input: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string>
  resolveApproval(
    requestId: number,
    decision: ApprovalDecision,
  ): void
  onEvent(listener: (event: AgentEvent) => void): () => void
  close(): Promise<void>
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

  constructor() {
    this.#child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
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
  }

  send(message: JsonRpcMessage): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
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
    if (this.#child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()))
    this.#child.kill("SIGTERM")
    await exited
  }

  #emitError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error)
  }
}

export class CodexAppServerAdapter implements AgentAdapter {
  #transportFactory: () => CodexTransport
  #transport: CodexTransport | undefined
  #nextId = 0
  #pending = new Map<number, PendingRequest>()
  #eventListeners = new Set<(event: AgentEvent) => void>()
  #unsubscribeMessage: (() => void) | undefined
  #unsubscribeError: (() => void) | undefined

  constructor(transportFactory: () => CodexTransport = () => new StdioCodexTransport()) {
    this.#transportFactory = transportFactory
  }

  async connect(): Promise<void> {
    if (this.#transport) return
    this.#transport = this.#transportFactory()
    this.#unsubscribeMessage = this.#transport.onMessage((message) => this.#receive(message))
    this.#unsubscribeError = this.#transport.onError?.((error) => this.#fail(error))
    await this.#request("initialize", {
      clientInfo: { name: "domovoi", title: "Domovoi", version: "0.0.1" },
    })
    this.#transport.send({ method: "initialized", params: {} })
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
    let cursor: string | null = null
    do {
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
        if (!id || !candidate.displayName || candidate.hidden) continue
        const supportedReasoningEfforts = (candidate.supportedReasoningEfforts ?? [])
          .map((option) => option.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string" && effort.length > 0)
        const defaultReasoningEffort = candidate.defaultReasoningEffort?.length
          ? candidate.defaultReasoningEffort
          : supportedReasoningEfforts[0] ?? "medium"
        models.push({
          provider: "codex",
          id,
          displayName: candidate.displayName,
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

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId })
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
    this.#unsubscribeMessage?.()
    this.#unsubscribeError?.()
    await this.#transport?.close()
    this.#transport = undefined
    this.#fail(new Error("Codex adapter closed"))
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#transport) return Promise.reject(new Error("Codex adapter is not connected"))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#transport!.send({ id, method, params })
    })
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
      this.#emit({ type: "turn-completed", params })
    }
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#eventListeners) listener(event)
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}
