import { randomUUID } from "node:crypto"

import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
} from "@opencode-ai/sdk"
import type { ApprovalDecision, ProviderModel, Runtime } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { normalizeProviderUsage } from "./usage.js"
import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"

type OpenCodeResult<T> = { data?: T; error?: unknown }

export type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

export type OpenCodeClient = {
  config: {
    get(options?: Record<string, unknown>): Promise<OpenCodeResult<{ model?: string }>>
    providers(options?: Record<string, unknown>): Promise<OpenCodeResult<{
      providers: Array<{
        id: string
        name: string
        models: Record<string, {
          id: string
          providerID: string
          name: string
          status?: string
          capabilities?: { reasoning?: boolean }
        }>
      }>
      default: Record<string, string>
    }>>
  }
  session: {
    create(options: Record<string, unknown>): Promise<OpenCodeResult<{ id: string }>>
    get(options: Record<string, unknown>): Promise<OpenCodeResult<{ id: string }>>
    delete(options: Record<string, unknown>): Promise<OpenCodeResult<boolean>>
    abort(options: Record<string, unknown>): Promise<OpenCodeResult<boolean>>
    promptAsync(options: Record<string, unknown>): Promise<OpenCodeResult<void>>
  }
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<OpenCodeEvent> }>
  }
  postSessionIdPermissionsPermissionId(
    options: Record<string, unknown>,
  ): Promise<OpenCodeResult<boolean>>
}

export type OpenCodeFactory = () => Promise<{
  client: OpenCodeClient
  server: { close(): void }
}>

export type OpenCodeAdapterIdentity = {
  providerId: string
  providerName: string
}

type Session = {
  threadId: string
  cwd: string
  runtime: Runtime
  activeTurnId?: string
  assistantMessageIds: Set<string>
  toolPhases: Map<string, string>
}

type DirectoryStream = {
  controller: AbortController
  threadIds: Set<string>
}

type PendingApproval = {
  threadId: string
  cwd: string
  permissionId: string
}

type PendingSessionLoad = {
  cwd: string
  cancelled: boolean
}

export function openCodeAgentFor(runtime: Runtime): string {
  if (runtime.permissionMode === "plan") return "plan"
  if (runtime.permissionMode === "build" && runtime.auto) return "domovoi-auto"
  return "build"
}

export class OpenCodeSdkAdapter implements AgentAdapter {
  readonly permissionCapabilities = { buildAuto: "pre-execution" } as const
  readonly #factory: OpenCodeFactory
  readonly #id: () => string
  readonly #identity: OpenCodeAdapterIdentity
  #runtime: Awaited<ReturnType<OpenCodeFactory>> | undefined
  #connection: Promise<void> | undefined
  #sessions = new Map<string, Session>()
  #pendingSessionLoads = new Map<string, PendingSessionLoad>()
  #directories = new Map<string, DirectoryStream>()
  #listeners = new Set<(event: AgentEvent) => void>()
  #pendingApprovals = new Map<number, PendingApproval>()
  #nextApprovalId = 0

  constructor(
    factory: OpenCodeFactory = defaultOpenCodeFactory,
    id: () => string = randomUUID,
    identity: OpenCodeAdapterIdentity = { providerId: "opencode", providerName: "OpenCode" },
  ) {
    this.#factory = factory
    this.#id = id
    this.#identity = identity
  }

  async connect(): Promise<void> {
    if (this.#runtime) return
    this.#connection ??= this.#factory().then((runtime) => {
      this.#runtime = runtime
    })
    try {
      await this.#connection
    } finally {
      this.#connection = undefined
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const client = await this.#client()
    const [config, catalog] = await Promise.all([
      client.config.get({ throwOnError: true }),
      client.config.providers({ throwOnError: true }),
    ])
    const configured = unwrap(config, `${this.#identity.providerName} config`)
    const providerCatalog = unwrap(catalog, `${this.#identity.providerName} provider catalog`)
    const models = providerCatalog.providers
      .flatMap((provider) => Object.values(provider.models).map((model) => ({ provider, model })))
      .filter(({ model }) => model.status !== "deprecated")
      .sort((left, right) =>
        left.provider.name.localeCompare(right.provider.name)
        || left.model.name.localeCompare(right.model.name),
      )
    const defaultModel = configured.model
      ?? models.map(({ provider, model }) => ({
        id: `${provider.id}/${model.id}`,
        isProviderDefault: providerCatalog.default[provider.id] === model.id,
      })).find((candidate) => candidate.isProviderDefault)?.id
      ?? (models[0] ? `${models[0].provider.id}/${models[0].model.id}` : undefined)

    return models.map(({ provider, model }) => {
      const id = `${provider.id}/${model.id}`
      const reasoning = model.capabilities?.reasoning === true ? "medium" : "none"
      return {
        provider: this.#identity.providerId,
        id,
        displayName: `${provider.name} / ${model.name}`,
        description: `${this.#identity.providerName} model from ${provider.name}`,
        supportedReasoningEfforts: [reasoning],
        defaultReasoningEffort: reasoning,
        isDefault: id === defaultModel,
      }
    })
  }

  async startThread({ cwd, runtime }: { cwd: string; runtime: Runtime }): Promise<string> {
    const client = await this.#client()
    const created = unwrap(await client.session.create({
      query: { directory: cwd },
      body: { title: "Domovoi session" },
      throwOnError: true,
    }), `${this.#identity.providerName} session creation`)
    try {
      await this.#loadSession(created.id, cwd, runtime)
    } catch (error) {
      try {
        await client.session.delete({
          path: { id: created.id },
          query: { directory: cwd },
          throwOnError: true,
        })
      } catch (cleanupError) {
        console.error(`Domovoi could not remove a failed ${this.#identity.providerName} session`, cleanupError)
      }
      throw error
    }
    return created.id
  }

  async resumeThread({ threadId, cwd, runtime }: {
    threadId: string
    cwd: string
    runtime: Runtime
  }): Promise<void> {
    if (this.#sessions.has(threadId)) return
    const pending = { cwd, cancelled: false }
    this.#pendingSessionLoads.set(threadId, pending)
    try {
      const client = await this.#client()
      const session = unwrap(await client.session.get({
        path: { id: threadId },
        query: { directory: cwd },
        throwOnError: true,
      }), `${this.#identity.providerName} session resume`)
      if (session.id !== threadId) {
        throw new Error(`${this.#identity.providerName} did not resume the requested session`)
      }
      await this.#loadSession(threadId, cwd, runtime, pending)
    } finally {
      if (this.#pendingSessionLoads.get(threadId) === pending) {
        this.#pendingSessionLoads.delete(threadId)
      }
    }
  }

  async startTurn({ threadId, prompt, runtime }: {
    threadId: string
    cwd: string
    prompt: string
    runtime: Runtime
  }): Promise<string> {
    const session = this.#requireSession(threadId)
    const turnId = this.#id()
    session.runtime = runtime
    session.activeTurnId = turnId
    try {
      await this.#sendPrompt(session, turnId, prompt, runtime)
    } catch (error) {
      delete session.activeTurnId
      throw error
    }
    return turnId
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) {
      throw new Error(`${this.#identity.providerName} turn is no longer active`)
    }
    await this.#sendPrompt(session, this.#id(), prompt, session.runtime)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#requireSession(threadId)
    if (session.activeTurnId !== turnId) return
    const client = await this.#client()
    unwrap(await client.session.abort({
      path: { id: threadId },
      query: { directory: session.cwd },
      throwOnError: true,
    }), `${this.#identity.providerName} turn interruption`)
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId)
    const pending = this.#pendingSessionLoads.get(threadId)
    if (!session && !pending) return
    if (pending) pending.cancelled = true
    const cwd = session?.cwd ?? pending!.cwd
    const client = await this.#client()
    if (session?.activeTurnId) {
      unwrap(await client.session.abort({
        path: { id: threadId },
        query: { directory: cwd },
        throwOnError: true,
      }), `${this.#identity.providerName} session interruption`)
    }
    unwrap(await client.session.delete({
      path: { id: threadId },
      query: { directory: cwd },
      throwOnError: true,
    }), `${this.#identity.providerName} session deletion`)
    if (session) this.#unloadSession(session)
  }

  resolveApproval(requestId: number, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) return
    this.#pendingApprovals.delete(requestId)
    const response = decision === "allow-once"
      ? "once"
      : decision === "always-project"
        ? "always"
        : "reject"
    void this.#client().then(async (client) => {
      unwrap(await client.postSessionIdPermissionsPermissionId({
        path: { id: pending.threadId, permissionID: pending.permissionId },
        query: { directory: pending.cwd },
        body: { response },
        throwOnError: true,
      }), `${this.#identity.providerName} permission response`)
    }).catch((error: unknown) => {
      console.error(`Domovoi could not resolve a ${this.#identity.providerName} permission`, error)
    })
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    for (const directory of this.#directories.values()) directory.controller.abort()
    this.#directories.clear()
    this.#sessions.clear()
    this.#pendingApprovals.clear()
    this.#runtime?.server.close()
    this.#runtime = undefined
  }

  async #client(): Promise<OpenCodeClient> {
    await this.connect()
    return this.#runtime!.client
  }

  async #loadSession(
    threadId: string,
    cwd: string,
    runtime: Runtime,
    pending?: PendingSessionLoad,
  ): Promise<void> {
    const session: Session = {
      threadId,
      cwd,
      runtime,
      assistantMessageIds: new Set(),
      toolPhases: new Map(),
    }
    const existing = this.#directories.get(cwd)
    if (existing) {
      if (pending?.cancelled) {
        throw new Error(`${this.#identity.providerName} session stopped while resuming`)
      }
      this.#sessions.set(threadId, session)
      existing.threadIds.add(threadId)
      return
    }
    const controller = new AbortController()
    const client = await this.#client()
    const events = await client.event.subscribe({
      query: { directory: cwd },
      signal: controller.signal,
    })
    if (pending?.cancelled) {
      controller.abort()
      throw new Error(`${this.#identity.providerName} session stopped while resuming`)
    }
    this.#directories.set(cwd, { controller, threadIds: new Set([threadId]) })
    this.#sessions.set(threadId, session)
    void this.#consume(cwd, events.stream).catch((error: unknown) => {
      if (controller.signal.aborted) return
      for (const candidate of this.#sessions.values()) {
        if (candidate.cwd !== cwd || !candidate.activeTurnId) continue
        this.#complete(
          candidate,
          "failed",
          error instanceof Error ? error.message : `${this.#identity.providerName} event stream failed`,
        )
      }
    })
  }

  #unloadSession(session: Session): void {
    this.#sessions.delete(session.threadId)
    const directory = this.#directories.get(session.cwd)
    if (!directory) return
    directory.threadIds.delete(session.threadId)
    if (directory.threadIds.size > 0) return
    directory.controller.abort()
    this.#directories.delete(session.cwd)
  }

  async #sendPrompt(
    session: Session,
    messageId: string,
    prompt: string,
    runtime: Runtime,
  ): Promise<void> {
    const client = await this.#client()
    const model = openCodeModel(runtime.model)
    ensureSuccess(await client.session.promptAsync({
      path: { id: session.threadId },
      query: { directory: session.cwd },
      body: {
        messageID: messageId,
        agent: openCodeAgentFor(runtime),
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: prompt }],
      },
      throwOnError: true,
    }), `${this.#identity.providerName} prompt`)
  }

  async #consume(cwd: string, stream: AsyncIterable<OpenCodeEvent>): Promise<void> {
    for await (const event of stream) this.#receive(cwd, event)
  }

  #receive(cwd: string, event: OpenCodeEvent): void {
    const properties = event.properties
    const sessionId = eventSessionId(event)
    if (!sessionId) return
    const session = this.#sessions.get(sessionId)
    if (!session || session.cwd !== cwd || !session.activeTurnId) return
    const turnId = session.activeTurnId

    if (event.type === "message.updated") {
      const info = asRecord(properties.info)
      if (info?.role === "assistant" && typeof info.id === "string") {
        session.assistantMessageIds.add(info.id)
        const usage = normalizeProviderUsage(info)
        if (usage) this.#emit({ type: "usage", threadId: sessionId, turnId, usage })
      }
      return
    }
    if (event.type === "message.part.updated") {
      const part = asRecord(properties.part)
      if (
        typeof part?.messageID !== "string"
        || !session.assistantMessageIds.has(part.messageID)
      ) return
      if (part?.type === "text" && typeof properties.delta === "string") {
        this.#emit({ type: "text-delta", threadId: sessionId, turnId, delta: properties.delta })
      }
      if (part?.type === "tool") this.#receiveTool(session, turnId, part)
      return
    }
    if (event.type === "permission.updated") {
      const permissionId = typeof properties.id === "string" ? properties.id : undefined
      if (!permissionId) return
      const requestId = ++this.#nextApprovalId
      const metadata = asRecord(properties.metadata)
      const command = typeof metadata?.command === "string"
        ? metadata.command
        : typeof properties.title === "string"
          ? properties.title
          : typeof properties.type === "string"
            ? properties.type
            : `${this.#identity.providerName} tool`
      this.#pendingApprovals.set(requestId, { threadId: sessionId, cwd, permissionId })
      this.#emit({
        type: "approval-requested",
        requestId,
        threadId: sessionId,
        turnId,
        ...(typeof properties.callID === "string" ? { itemId: properties.callID } : {}),
        command,
        cwd,
        ...(typeof properties.title === "string" ? { reason: properties.title } : {}),
      })
      return
    }
    if (event.type === "session.error") {
      const error = asRecord(properties.error)
      this.#complete(session, "failed", errorMessage(error, this.#identity.providerName))
      return
    }
    if (event.type === "session.idle") this.#complete(session, "completed")
  }

  #receiveTool(session: Session, turnId: string, part: Record<string, unknown>): void {
    const callId = typeof part.callID === "string" ? part.callID : undefined
    const tool = typeof part.tool === "string" ? part.tool : undefined
    const state = asRecord(part.state)
    if (!callId || !tool || !state || typeof state.status !== "string") return
    if (session.toolPhases.get(callId) === state.status) return
    session.toolPhases.set(callId, state.status)
    const input = asRecord(state.input) ?? {}
    const command = typeof input.command === "string" ? input.command : tool
    if (state.status === "running" && tool === "bash") {
      this.#emit({
        type: "item",
        phase: "started",
        params: {
          threadId: session.threadId,
          turnId,
          item: { type: "commandExecution", id: callId, command: [command], status: "inProgress" },
        },
      })
      return
    }
    if (state.status !== "completed" && state.status !== "error") return
    if (tool === "bash") {
      this.#emit({
        type: "item",
        phase: "completed",
        params: {
          threadId: session.threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: callId,
            command: [command],
            status: state.status === "error" ? "failed" : "completed",
            aggregatedOutput: typeof state.output === "string"
              ? state.output
              : typeof state.error === "string" ? state.error : "",
          },
        },
      })
      return
    }
    const path = filePath(input)
    if (path && state.status === "completed") {
      this.#emit({
        type: "item",
        phase: "completed",
        params: {
          threadId: session.threadId,
          turnId,
          item: { type: "fileChange", id: callId, changes: [{ path }] },
        },
      })
    }
  }

  #complete(session: Session, status: "completed" | "failed", error?: string): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    this.#emit({
      type: "turn-completed",
      params: {
        threadId: session.threadId,
        turnId,
        turn: { id: turnId, status, ...(error ? { error } : {}) },
      },
    })
    delete session.activeTurnId
    session.toolPhases.clear()
  }

  #requireSession(threadId: string): Session {
    const session = this.#sessions.get(threadId)
    if (!session) {
      throw new Error(`${this.#identity.providerName} session ${threadId} is not loaded`)
    }
    return session
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function openCodeModel(id: string): { providerID: string; modelID: string } | undefined {
  const separator = id.indexOf("/")
  if (separator < 1 || separator === id.length - 1) return undefined
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) }
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  if (typeof event.properties.sessionID === "string") return event.properties.sessionID
  const part = asRecord(event.properties.part)
  if (typeof part?.sessionID === "string") return part.sessionID
  const info = asRecord(event.properties.info)
  return typeof info?.sessionID === "string" ? info.sessionID : undefined
}

function filePath(input: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path"]) {
    if (typeof input[key] === "string") return input[key]
  }
  return undefined
}

function errorMessage(error: Record<string, unknown> | undefined, providerName: string): string {
  const data = asRecord(error?.data)
  if (typeof data?.message === "string") return data.message
  if (typeof error?.message === "string") return error.message
  return `${providerName} session failed`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function unwrap<T>(result: OpenCodeResult<T>, action: string): T {
  if (result.error !== undefined) throw new Error(`${action} failed`)
  if (result.data === undefined) throw new Error(`${action} returned no data`)
  return result.data
}

function ensureSuccess(result: OpenCodeResult<unknown>, action: string): void {
  if (result.error !== undefined) throw new Error(`${action} failed`)
}

export const domovoiOpenCodeConfig: Config = {
  autoupdate: false,
  agent: {
    plan: {
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        external_directory: "deny",
      },
    },
    build: {
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        doom_loop: "ask",
        external_directory: "ask",
      },
    },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        doom_loop: "ask",
        external_directory: "ask",
      },
    },
  },
}

const defaultOpenCodeFactory: OpenCodeFactory = async () => {
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "OPENCODE_SERVER_PASSWORD",
    usernameEnvironment: "OPENCODE_SERVER_USERNAME",
    username: "opencode",
    config: domovoiOpenCodeConfig,
    startServer: createOpencodeServer,
    createClient: createOpencodeClient,
  })
  return {
    client: runtime.client as unknown as OpenCodeClient,
    server: runtime.server,
  }
}
