import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"
import type { NormalizedUsage } from "./usage.js"

export type AgentEvent =
  | { type: "provider-disconnected"; reason: string }
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
      path?: string
      blockedPath?: string
      reason?: string
    }
  | { type: "item"; phase: "started" | "completed"; params: Record<string, unknown> }
  | { type: "usage"; threadId: string; turnId: string; usage: NormalizedUsage }
  | { type: "turn-completed"; params: Record<string, unknown> }

export type AgentPermissionCapabilities = Readonly<{
  ask: "read-only" | "unsupported"
  buildAuto: "pre-execution" | "unsupported"
}>

export type AgentCapabilities = Readonly<{ vision: boolean }>

export type AgentVisualContext = {
  annotationId: string
  mimeType: "image/png" | "image/jpeg" | "image/webp"
  bytes: Uint8Array
}

export interface AgentAdapter {
  readonly permissionCapabilities?: AgentPermissionCapabilities
  readonly capabilities?: AgentCapabilities
  connect(): Promise<void>
  /** Discard connection state while keeping the adapter reusable. */
  resetConnection?(): Promise<void>
  listModels(): Promise<ProviderModel[]>
  startThread(input: { cwd: string; runtime: Runtime }): Promise<string>
  resumeThread(input: { threadId: string; cwd: string; runtime: Runtime }): Promise<void>
  stopThread(threadId: string): Promise<void>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  startTurn(input: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
    visualContexts?: AgentVisualContext[]
  }): Promise<string>
  steerTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    visualContexts?: AgentVisualContext[],
  ): Promise<void>
  resolveApproval(requestId: number, decision: ApprovalDecision): void
  onEvent(listener: (event: AgentEvent) => void): () => void
  close(): Promise<void>
}

export class AgentProviderUnavailableError extends Error {}

export class AgentRegistry {
  readonly #adapters: ReadonlyMap<string, AgentAdapter>

  constructor(adapters: Readonly<Record<string, AgentAdapter>>) {
    for (const provider of Object.keys(adapters)) {
      if (!provider.trim()) throw new Error("Provider id cannot be empty")
    }
    this.#adapters = new Map(Object.entries(adapters))
  }

  providers(): string[] {
    return [...this.#adapters.keys()].sort()
  }

  adapters(): AgentAdapter[] {
    return [...new Set(this.#adapters.values())]
  }

  entries(): Array<[string, AgentAdapter]> {
    return [...this.#adapters.entries()].sort(([left], [right]) => left.localeCompare(right))
  }

  require(provider: string): AgentAdapter {
    const adapter = this.#adapters.get(provider)
    if (!adapter) {
      throw new AgentProviderUnavailableError(`Agent provider ${provider} is unavailable`)
    }
    return adapter
  }
}
