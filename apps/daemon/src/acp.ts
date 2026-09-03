import { randomUUID } from "node:crypto"

import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { AcpProviderDefinition } from "./acp-providers.js"
import { classifyProviderFailure } from "./provider-failures.js"
import { redactDurableText } from "./secret-redaction.js"
import { normalizeUsage } from "./usage.js"

export type AcpConfigOption = {
  id: string
  category?: string
  values: string[]
  currentValue?: string
}

export type AcpSessionSetup = {
  sessionId: string
  modes: string[]
  configOptions: AcpConfigOption[]
}

export type AcpPermissionOption = {
  id: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export type AcpPermissionRequest = {
  sessionId: string
  toolCallId: string
  title: string
  command?: string
  cwd?: string
  reason?: string
  options: AcpPermissionOption[]
}

export type AcpPermissionResult = { optionId: string } | { cancelled: true }

export type AcpUpdate =
  | { type: "text"; text: string }
  | { type: "plan"; text: string }
  | { type: "command"; toolCallId: string; output: string }
  | { type: "diff"; diff: string }
  | { type: "tool"; toolCallId: string; phase: "started" | "completed"; title: string }
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }

export type AcpPeerHandlers = {
  onUpdate(sessionId: string, update: AcpUpdate): void
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResult>
  onDisconnect(reason?: string): void
}

export interface AcpPeer {
  initialize(): Promise<void>
  startSession(cwd: string): Promise<AcpSessionSetup>
  resumeSession(sessionId: string, cwd: string): Promise<AcpSessionSetup>
  closeSession(sessionId: string): Promise<void>
  setMode(sessionId: string, mode: string): Promise<void>
  setConfig(sessionId: string, optionId: string, value: string): Promise<void>
  prompt(sessionId: string, prompt: string): Promise<{ stopReason: string }>
  cancel(sessionId: string): Promise<void>
  close(): Promise<void>
}

type PendingPermission = {
  request: AcpPermissionRequest
  resolve: (result: AcpPermissionResult) => void
}

type ActiveTurn = { id: string }

export class AcpAgentAdapter implements AgentAdapter {
  readonly permissionCapabilities: NonNullable<AgentAdapter["permissionCapabilities"]>

  readonly #definition: AcpProviderDefinition
  readonly #createPeer: (handlers: AcpPeerHandlers) => AcpPeer
  readonly #listProviderModels: () => Promise<ProviderModel[]>
  readonly #createId: () => string
  readonly #listeners = new Set<(event: AgentEvent) => void>()
  readonly #activeTurns = new Map<string, ActiveTurn>()
  readonly #pendingPermissions = new Map<number, PendingPermission>()
  #nextPermissionId = 1
  #peer: AcpPeer | undefined
  #disconnected = false

  constructor(input: {
    definition: AcpProviderDefinition
    createPeer: (handlers: AcpPeerHandlers) => AcpPeer
    listModels: () => Promise<ProviderModel[]>
    createId?: () => string
  }) {
    this.#definition = input.definition
    this.permissionCapabilities = {
      ask: input.definition.askEnforcement,
      buildAuto: "unsupported",
    }
    this.#createPeer = input.createPeer
    this.#listProviderModels = input.listModels
    this.#createId = input.createId ?? randomUUID
  }

  async connect(): Promise<void> {
    if (this.#peer) return
    this.#disconnected = false
    const peerState: { current?: AcpPeer } = {}
    const peer = this.#createPeer({
      onUpdate: (sessionId, update) => {
        if (this.#peer === peerState.current) this.#handleUpdate(sessionId, update)
      },
      onPermission: (request) => this.#peer === peerState.current
        ? this.#requestPermission(request)
        : Promise.resolve({ cancelled: true }),
      onDisconnect: (reason) => {
        if (peerState.current) this.#handleDisconnect(peerState.current, reason)
      },
    })
    peerState.current = peer
    this.#peer = peer
    try {
      await peer.initialize()
      if (this.#peer !== peer) {
        throw new Error(`${this.#definition.id} ACP connection reset during initialization`)
      }
    } catch (error) {
      if (this.#peer === peer) {
        this.#peer = undefined
        try {
          await peer.close()
        } catch {
          // Preserve the initialization failure; the failed peer is already detached.
        }
      }
      throw error
    }
  }

  async resetConnection(): Promise<void> {
    await this.close()
  }

  listModels(): Promise<ProviderModel[]> {
    return this.#listProviderModels()
  }

  async startThread(input: { cwd: string; runtime: Runtime }): Promise<string> {
    const setup = await this.#requirePeer().startSession(input.cwd)
    await this.#configure(setup, input.runtime)
    return setup.sessionId
  }

  async resumeThread(input: { threadId: string; cwd: string; runtime: Runtime }): Promise<void> {
    const setup = await this.#requirePeer().resumeSession(input.threadId, input.cwd)
    await this.#configure(setup, input.runtime)
  }

  async stopThread(threadId: string): Promise<void> {
    this.#cancelPermissions(threadId)
    const active = this.#activeTurns.delete(threadId)
    if (active) await this.#requirePeer().cancel(threadId)
    await this.#requirePeer().closeSession(threadId)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const active = this.#activeTurns.get(threadId)
    if (active && active.id !== turnId) throw new Error("ACP turn is not active")
    this.#cancelPermissions(threadId)
    await this.#requirePeer().cancel(threadId)
  }

  async startTurn(input: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string> {
    if (this.#activeTurns.has(input.threadId)) throw new Error("ACP session already has an active turn")
    const turnId = this.#createId()
    this.#activeTurns.set(input.threadId, { id: turnId })
    void this.#runPrompt(input.threadId, turnId, input.prompt)
    return turnId
  }

  async steerTurn(_threadId: string, _turnId: string, _prompt: string): Promise<void> {
    throw new Error(`${this.#definition.id} does not support mid-turn steering`)
  }

  resolveApproval(requestId: number, decision: ApprovalDecision): void {
    const pending = this.#pendingPermissions.get(requestId)
    if (!pending) return
    this.#pendingPermissions.delete(requestId)
    const desired = decision === "allow-once" || decision === "always-project"
      ? "allow_once"
      : "reject_once"
    const option = pending.request.options.find((candidate) => candidate.kind === desired)
    pending.resolve(option ? { optionId: option.id } : { cancelled: true })
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    for (const pending of this.#pendingPermissions.values()) pending.resolve({ cancelled: true })
    this.#pendingPermissions.clear()
    const peer = this.#peer
    this.#peer = undefined
    if (peer) await peer.close()
  }

  async #configure(setup: AcpSessionSetup, runtime: Runtime): Promise<void> {
    const peer = this.#requirePeer()
    await this.#setOption(peer, setup, "model", runtime.model)
    if (runtime.reasoning !== "none") {
      await this.#setOption(peer, setup, "thought_level", runtime.reasoning)
    }
    const mode = this.#definition.modes[runtime.permissionMode]
    if (!setup.modes.includes(mode)) {
      throw new Error(`${this.#definition.id} does not advertise mode ${mode}`)
    }
    await peer.setMode(setup.sessionId, mode)
  }

  async #setOption(peer: AcpPeer, setup: AcpSessionSetup, category: string, value: string): Promise<void> {
    const option = setup.configOptions.find((candidate) => candidate.category === category)
    if (!option) return
    if (!option.values.includes(value)) {
      throw new Error(`${this.#definition.id} does not advertise ${category} ${value}`)
    }
    if (option.currentValue !== value) await peer.setConfig(setup.sessionId, option.id, value)
  }

  async #runPrompt(threadId: string, turnId: string, prompt: string): Promise<void> {
    try {
      const response = await this.#requirePeer().prompt(threadId, prompt)
      if (this.#activeTurns.get(threadId)?.id !== turnId) return
      const failed = !["end_turn", "cancelled"].includes(response.stopReason)
      this.#emit({
        type: "turn-completed",
        params: {
          threadId,
          turnId,
          status: failed ? "failed" : "completed",
          ...(failed ? { reason: boundedStopReason(response.stopReason) } : {}),
        },
      })
    } catch (error) {
      if (this.#activeTurns.get(threadId)?.id !== turnId) return
      const failure = classifyProviderFailure(error)
      this.#emit({
        type: "turn-completed",
        params: { threadId, turnId, status: "failed", reason: failure.message, failure },
      })
    } finally {
      if (this.#activeTurns.get(threadId)?.id === turnId) {
        this.#activeTurns.delete(threadId)
      }
    }
  }

  #requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionResult> {
    const requestId = this.#nextPermissionId++
    return new Promise((resolve) => {
      this.#pendingPermissions.set(requestId, { request, resolve })
      this.#emit({
        type: "approval-requested",
        requestId,
        threadId: request.sessionId,
        itemId: request.toolCallId,
        ...(request.command ? { command: request.command } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        reason: request.reason ?? request.title,
      })
    })
  }

  #cancelPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingPermissions) {
      if (pending.request.sessionId !== sessionId) continue
      this.#pendingPermissions.delete(requestId)
      pending.resolve({ cancelled: true })
    }
  }

  #handleUpdate(threadId: string, update: AcpUpdate): void {
    const turnId = this.#activeTurns.get(threadId)?.id
    const context = { threadId, ...(turnId ? { turnId } : {}) }
    if (update.type === "usage") {
      if (!turnId) return
      this.#emit({
        type: "usage",
        threadId,
        turnId,
        usage: normalizeUsage({
          totalTokens: update.used,
          contextTokens: update.used,
          contextWindowTokens: update.size,
          ...(update.cost ? { cost: update.cost } : {}),
        }),
      })
    } else if (update.type === "text") {
      this.#emit({ type: "text-delta", ...context, delta: update.text })
    } else if (update.type === "plan") {
      this.#emit({ type: "plan-delta", ...context, delta: update.text })
    } else if (update.type === "command") {
      this.#emit({ type: "command-output", ...context, itemId: update.toolCallId, delta: update.output })
    } else if (update.type === "diff") {
      this.#emit({ type: "diff-updated", ...context, diff: update.diff })
    } else {
      this.#emit({
        type: "item",
        phase: update.phase,
        params: { ...context, item: { id: update.toolCallId, title: update.title } },
      })
    }
  }

  #handleDisconnect(peer: AcpPeer, reason?: string): void {
    if (this.#peer !== peer) return
    this.#peer = undefined
    if (this.#disconnected) return
    this.#disconnected = true
    this.#activeTurns.clear()
    for (const pending of this.#pendingPermissions.values()) pending.resolve({ cancelled: true })
    this.#pendingPermissions.clear()
    this.#emit({
      type: "provider-disconnected",
      reason: reason ? redactDurableText(reason).value : "Provider process exited unexpectedly",
    })
  }

  #requirePeer(): AcpPeer {
    if (!this.#peer) throw new Error(`${this.#definition.id} is not connected`)
    return this.#peer
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function boundedStopReason(reason: string): string {
  if (reason === "max_tokens") return "Provider reached its token limit"
  if (reason === "max_turn_requests") return "Provider reached its turn limit"
  if (reason === "refusal") return "Provider refused the request"
  return "Provider stopped before completing the turn"
}
