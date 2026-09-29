import type {
  ApprovalDecision,
  ApprovalToolServer,
  ProviderModel,
  ProviderUsageLimits,
  Runtime,
  WorkingPlanStepStatus,
} from "@getdomovoi/protocol"
import type { NormalizedUsage, UsageSource } from "./usage.js"
import type { ApprovalScope } from "./approval-facts.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"

export type ProviderApprovalDecision = Exclude<ApprovalDecision, "always-project">

export type AgentWorkingPlanStep = {
  text: string
  status: WorkingPlanStepStatus
}

export type AgentEvent =
  | { type: "provider-disconnected"; reason: string }
  | { type: "text-delta"; threadId?: string; turnId?: string; itemId?: string; delta: string }
  | { type: "plan-delta"; threadId?: string; turnId?: string; delta: string }
  | { type: "plan-updated"; threadId: string; turnId?: string; steps: AgentWorkingPlanStep[] }
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
      /** The provider tool, when the request is neither a shell command nor a file tool. */
      tool?: string
      /** The tool server whose tool is called, as the provider names it. */
      toolServer?: ApprovalToolServer
    }
  | {
      type: "policy-refused"
      threadId: string
      turnId?: string
      itemId?: string
      command: string
      reason: string
    }
  | { type: "item"; phase: "started" | "completed"; params: Record<string, unknown> }
  | { type: "usage"; threadId: string; turnId: string; usage: NormalizedUsage; source?: UsageSource }
  | { type: "turn-completed"; params: Record<string, unknown> }

export type AgentPermissionCapabilities = Readonly<{
  ask: "read-only" | "unsupported"
  buildAuto: "pre-execution" | "unsupported"
}>

export type AgentCapabilities = Readonly<{ vision: boolean }>
export type { ApprovalScope } from "./approval-facts.js"

export type AgentVisualContext = {
  mimeType: "image/png" | "image/jpeg" | "image/webp"
  bytes: Uint8Array
} & ({ annotationId: string; attachmentIndex?: never } | { attachmentIndex: number; annotationId?: never })

// This machine's trust grant for the session's repository, looked up by the
// daemon at the call that carries it. An adapter decides what it may load
// with repositoryTrustVerdict (repository-trust-apply.ts) against the worktree
// it opens; absent, nothing the repository brings loads. Claude Code uses it
// (P6b); every other adapter ignores it until its own slice (Codex in P6c).
export type AgentRepositoryTrust = RepositoryTrustGrant

export interface AgentAdapter {
  readonly permissionCapabilities?: AgentPermissionCapabilities
  readonly capabilities?: AgentCapabilities
  /** What an approved command can reach in this runtime. Absent means no sandbox at all. */
  approvalScope?(runtime: Runtime): ApprovalScope
  connect(): Promise<void>
  /** Discard connection state while keeping the adapter reusable. */
  resetConnection?(): Promise<void>
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>
  usageLimits?(signal?: AbortSignal): Promise<ProviderUsageLimits | undefined>
  startThread(input: { cwd: string; runtime: Runtime; repositoryTrust?: AgentRepositoryTrust }): Promise<string>
  resumeThread(input: { threadId: string; cwd: string; runtime: Runtime; repositoryTrust?: AgentRepositoryTrust }): Promise<void>
  stopThread(threadId: string): Promise<void>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  startTurn(input: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
    visualContexts?: AgentVisualContext[]
    repositoryTrust?: AgentRepositoryTrust
  }): Promise<string>
  steerTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    visualContexts?: AgentVisualContext[],
  ): Promise<void | { providerMessageId: string }>
  // Domovoi owns project-scoped rules. Provider adapters receive only
  // one-shot grants so provider-native policy cannot outlive daemon state.
  resolveApproval(requestId: number, decision: ProviderApprovalDecision): void
  onEvent(listener: (event: AgentEvent) => void): () => void
  close(): Promise<void>
}

export class AgentProviderUnavailableError extends Error {
  // What a stored session of this provider is told when it cannot continue.
  readonly resumeMessage: string

  constructor(message: string, resumeMessage: string = message) {
    super(message)
    this.resumeMessage = resumeMessage
  }
}

export type UnavailableProvider = Readonly<{ reason: string; resumeRefusal: string }>

export class AgentRegistry {
  readonly #adapters: ReadonlyMap<string, AgentAdapter>
  readonly #unavailable: ReadonlyMap<string, UnavailableProvider>

  // Providers in `unavailable` have no adapter and are refused with their own
  // words instead of the generic one.
  constructor(
    adapters: Readonly<Record<string, AgentAdapter>>,
    unavailable: Readonly<Record<string, UnavailableProvider>> = {},
  ) {
    for (const provider of Object.keys(adapters)) {
      if (!provider.trim()) throw new Error("Provider id cannot be empty")
    }
    this.#adapters = new Map(Object.entries(adapters))
    this.#unavailable = new Map(Object.entries(unavailable).filter(([provider]) => !this.#adapters.has(provider)))
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

  // A provider the daemon does not run, so it holds no thread to stop.
  isUnavailable(provider: string): boolean {
    return this.#unavailable.has(provider)
  }

  require(provider: string): AgentAdapter {
    const adapter = this.#adapters.get(provider)
    if (!adapter) {
      const unavailable = this.#unavailable.get(provider)
      if (unavailable) throw new AgentProviderUnavailableError(unavailable.reason, unavailable.resumeRefusal)
      throw new AgentProviderUnavailableError(`Agent provider ${provider} is unavailable`)
    }
    return adapter
  }
}
