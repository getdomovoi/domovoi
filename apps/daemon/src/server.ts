import { createServer, type Server as HttpServer } from "node:http"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { arch, homedir, hostname, platform } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import {
  createEmptyWorkspace,
  daemonAuthenticationErrorCode,
  demoWorkspace,
  protocolVersion,
  rpcMethods,
  rpcRequestSchema,
  workspaceSnapshotSchema,
  type Annotation,
  type Artifact,
  type ProviderModel,
  type RpcMethod,
  type ClientKind,
  type Runtime,
  type TerminalOwner,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from "ws"

import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import {
  CodexAppServerAdapter,
} from "./codex.js"
import { ClaudeAgentSdkAdapter } from "./claude.js"
import { OpenCodeSdkAdapter } from "./opencode.js"
import { KiloSdkAdapter } from "./kilo.js"
import {
  AgentProviderUnavailableError,
  AgentRegistry,
  type AgentAdapter,
  type AgentEvent,
} from "./agents.js"
import { GitWorkspaceService, type WorkspaceService } from "./workspace.js"
import {
  injectPreviewBridge,
  validPreviewBridgeChannel,
  validPreviewParentOrigin,
} from "./preview-bridge.js"
import { agentPromptWithAnnotations } from "./annotation-context.js"
import { agentPromptWithHandoff } from "./handoff-context.js"
import {
  NodePtyTerminalService,
  type TerminalProcess,
  type TerminalService,
} from "./terminal.js"
import type { ProviderProbe } from "./providers.js"
import { FileSkillCatalog, skillRoots, type SkillCatalog } from "./skills.js"

const invalidRequest = -32600
const methodNotFound = -32601
const invalidParams = -32602
const internalError = -32603
const maximumAuthenticationFailures = 3
const maximumTerminalBufferLength = 256 * 1_024

class RuntimeValidationError extends Error {}

export function appendPlanDelta(
  artifacts: Artifact[],
  annotations: Annotation[],
  sessionId: string,
  delta: string,
): Artifact {
  const artifactId = `plan-${sessionId}`
  const legacyPrefix = `${artifactId}-`
  const matching = artifacts.filter((artifact) =>
    artifact.sessionId === sessionId
    && artifact.type === "plan"
    && (artifact.id === artifactId || artifact.id.startsWith(legacyPrefix)),
  )

  if (matching.length === 0) {
    const artifact: Artifact = {
      id: artifactId,
      sessionId,
      title: "Working plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content: delta,
    }
    artifacts.push(artifact)
    return artifact
  }

  const mergedIds = new Set(matching.map((candidate) => candidate.id))
  const artifact = matching.find((candidate) => candidate.id === artifactId) ?? matching[0]!
  artifact.id = artifactId
  artifact.title = "Working plan"
  artifact.mimeType = "text/markdown"
  artifact.content = `${matching.map((candidate) => candidate.content ?? "").join("")}${delta}`
  artifact.revision = matching.reduce((total, candidate) => total + candidate.revision, 0) + 1

  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    if (matching.includes(artifacts[index]!) && artifacts[index] !== artifact) artifacts.splice(index, 1)
  }
  for (const annotation of annotations) {
    if (annotation.sessionId === sessionId && mergedIds.has(annotation.artifactId)) {
      annotation.artifactId = artifactId
    }
  }
  return artifact
}

export type DaemonServerOptions = {
  host?: string
  port?: number
  allowedOrigins?: string[]
  statePath?: string
  store?: WorkspaceStore
  agent?: AgentAdapter
  agents?: Readonly<Record<string, AgentAdapter>>
  workspaceService?: WorkspaceService
  worktreeRoot?: string
  agentTimeoutMs?: number
  modelCacheTtlMs?: number
  authToken?: string
  allowRemoteTransport?: boolean
  authTimeoutMs?: number
  terminalService?: TerminalService
  providerProbe?: ProviderProbe
  skillCatalog?: SkillCatalog
}

type ActiveTerminal = {
  sessionId: string
  process: TerminalProcess
  cols: number
  rows: number
  shell: string
  cwd: string
  buffer: string
  owner: TerminalOwner
  disposeData: () => void
  disposeExit: () => void
}

export class DomovoiDaemon {
  readonly host: string
  readonly requestedPort: number
  readonly allowedOrigins: ReadonlySet<string>
  #http: HttpServer | undefined
  #websocket: WebSocketServer | undefined
  #snapshot: WorkspaceSnapshot
  #store: WorkspaceStore
  #agents: AgentRegistry
  #workspaceService: WorkspaceService
  #connectedAgents = new Set<string>()
  #agentConnections = new Map<string, Promise<void>>()
  #providerModels = new Map<string, { models: ProviderModel[]; cachedAt: number }>()
  #providerModelRequests = new Map<string, Promise<ProviderModel[]>>()
  #loadedAgentThreads = new Set<string>()
  #unsubscribeAgents: Array<() => void>
  #mutationQueue = Promise.resolve()
  #deltaFlush: ReturnType<typeof setTimeout> | undefined
  #agentTimeoutMs: number
  #modelCacheTtlMs: number
  #authToken: string | undefined
  #authenticatedClients = new WeakSet<WebSocket>()
  #authenticationDeadlines = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()
  #authenticationFailures = new WeakMap<WebSocket, number>()
  #authTimeoutMs: number
  #artifactSigningSecret = randomBytes(32).toString("base64url")
  #artifactAccessTtlSeconds = 60
  #terminalService: TerminalService
  #terminals = new Map<string, ActiveTerminal>()
  #providerProbe: ProviderProbe | undefined
  #providerRefresh: Promise<void> | undefined
  #skillCatalog: SkillCatalog | undefined

  constructor(options: DaemonServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
    this.requestedPort = options.port ?? 47831
    this.#modelCacheTtlMs = Math.max(0, options.modelCacheTtlMs ?? 60_000)
    if (!isLoopbackHost(this.host) && !options.allowRemoteTransport) {
      throw new Error("Non-loopback listeners require explicit protected-transport opt-in")
    }
    if (!isLoopbackHost(this.host) && !options.authToken) {
      throw new Error("A daemon token is required outside loopback")
    }
    this.allowedOrigins = new Set(
      options.allowedOrigins ?? ["http://127.0.0.1:5178", "http://localhost:5178", "file://"],
    )
    const machineName = hostname()
    const machinePlatform = platform()
    const machineArch = arch()
    const initialSnapshot = createEmptyWorkspace({
      id: `machine-${createHash("sha256").update(`${machineName}:${machinePlatform}:${machineArch}`).digest("hex").slice(0, 12)}`,
      name: machineName,
      platform: machinePlatform,
      arch: machineArch,
      version: "0.0.1",
      connection: "local",
      reachable: true,
      providers: [],
    })
    this.#store = options.store ?? new SqliteWorkspaceStore(
      options.statePath ?? join(homedir(), ".domovoi", "state.sqlite"),
      initialSnapshot,
      { legacySnapshots: [demoWorkspace] },
    )
    this.#snapshot = this.#store.load()
    this.#agents = new AgentRegistry(
      options.agents ?? {
        "claude-code": new ClaudeAgentSdkAdapter(),
        codex: options.agent ?? new CodexAppServerAdapter(),
        kilo: new KiloSdkAdapter(),
        opencode: new OpenCodeSdkAdapter(),
      },
    )
    this.#workspaceService = options.workspaceService ?? new GitWorkspaceService(
      options.worktreeRoot ?? join(homedir(), ".domovoi", "worktrees"),
    )
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 30_000
    this.#authToken = options.authToken
    this.#authTimeoutMs = options.authTimeoutMs ?? 5_000
    this.#terminalService = options.terminalService ?? new NodePtyTerminalService()
    this.#providerProbe = options.providerProbe
    this.#skillCatalog = options.skillCatalog
    this.#unsubscribeAgents = this.#agents.entries().map(([provider, agent]) =>
      agent.onEvent((event) => {
        this.#enqueueMutation(() => this.#handleAgentEvent(provider, event))
      }),
    )
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.#http?.address()
    if (!address || typeof address === "string") return undefined
    return { host: this.host, port: address.port }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.#http) throw new Error("Daemon is already running")

    this.#http = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "ok", protocolVersion }))
        return
      }

      if (request.method === "GET" && request.url?.startsWith("/artifacts/")) {
        if (!this.#acceptsHost(request.headers.host)) {
          response.writeHead(404, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "not_found" }))
          return
        }
        void this.#serveArtifact(request.url, response)
        return
      }

      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
    })

    const verifyClient: VerifyClientCallbackSync = ({ origin }) =>
      !origin || this.allowedOrigins.has(origin)

    this.#websocket = new WebSocketServer({
      server: this.#http,
      path: "/rpc",
      verifyClient,
    })
    this.#websocket.on("connection", (socket) => {
      if (this.#authToken) {
        const deadline = setTimeout(() => {
          if (!this.#authenticatedClients.has(socket)) socket.close(1008, "authentication timeout")
        }, this.#authTimeoutMs)
        this.#authenticationDeadlines.set(socket, deadline)
        socket.once("close", () => clearTimeout(deadline))
      }
      socket.on("message", (data) => {
        const raw = data.toString()
        if (
          this.#isConcurrentRead(raw)
          && (!this.#authToken || this.#authenticatedClients.has(socket))
        ) void this.#handle(socket, raw)
        else this.#enqueueMutation(() => this.#handle(socket, raw))
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.#http!.once("error", reject)
      this.#http!.listen(this.requestedPort, this.host, () => resolve())
    })

    if (this.#providerProbe) {
      this.#providerRefresh = this.#refreshProviderReadiness().catch((error: unknown) => {
        console.error("Domovoi could not inspect provider runtimes", error)
      })
    }

    return this.address!
  }

  async stop(): Promise<void> {
    this.#closeAllTerminals()
    for (const client of this.#websocket?.clients ?? []) client.close(1001, "daemon stopping")

    await new Promise<void>((resolve, reject) => {
      if (!this.#http) return resolve()
      this.#http.close((error) => (error ? reject(error) : resolve()))
    })

    this.#websocket = undefined
    this.#http = undefined
    await this.#providerRefresh
    await this.#mutationQueue
    if (this.#deltaFlush) this.#flushAgentState()
    for (const unsubscribe of this.#unsubscribeAgents) unsubscribe()
    await Promise.all(this.#agents.adapters().map((agent) => agent.close()))
    this.#store.close()
  }

  #send(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload))
  }

  #broadcastSnapshot(): void {
    this.#broadcastNotification("workspace.changed", this.#snapshot)
  }

  #broadcastNotification(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params })

    for (const client of this.#websocket?.clients ?? []) {
      if (
        client.readyState === WebSocket.OPEN
        && (!this.#authToken || this.#authenticatedClients.has(client))
      ) client.send(message)
    }
  }

  async #refreshProviderReadiness(): Promise<void> {
    const sessionProviders = new Set(this.#agents.providers())
    const providers = (await this.#providerProbe!.inspect()).map((provider) => ({
      ...provider,
      sessionCapable: sessionProviders.has(provider.id),
    }))
    this.#enqueueMutation(async () => {
      this.#snapshot.machine.providers = providers
      this.#snapshot = workspaceSnapshotSchema.parse(this.#snapshot)
      this.#store.save(this.#snapshot)
      this.#broadcastSnapshot()
    })
    await this.#mutationQueue
  }

  #error(socket: WebSocket, id: string | number | null, code: number, message: string): void {
    this.#send(socket, { jsonrpc: "2.0", id, error: { code, message } })
  }

  #acceptsHost(host: string | undefined): boolean {
    const address = this.address
    if (!host || !address) return false
    return hostAuthorityMatches(host, address.host, address.port)
  }

  #enqueueMutation(task: () => Promise<void>): void {
    this.#mutationQueue = this.#mutationQueue.then(task).catch((error: unknown) => {
      console.error("Domovoi mutation failed", error)
    })
  }

  #isConcurrentRead(raw: string): boolean {
    try {
      const request = JSON.parse(raw) as { method?: unknown }
      return request.method === "runtime.models" || request.method === "skill.list"
    } catch {
      return false
    }
  }

  async #ensureAgentConnected(provider = "codex"): Promise<AgentAdapter> {
    const agent = this.#agents.require(provider)
    if (this.#connectedAgents.has(provider)) return agent
    if (!this.#agentConnections.has(provider)) {
      const connection = agent.connect().then(() => {
        this.#connectedAgents.add(provider)
      })
      this.#agentConnections.set(provider, connection)
      void connection.then(
        () => { if (this.#agentConnections.get(provider) === connection) this.#agentConnections.delete(provider) },
        () => { if (this.#agentConnections.get(provider) === connection) this.#agentConnections.delete(provider) },
      )
    }
    await withTimeout(
      this.#agentConnections.get(provider)!,
      this.#agentTimeoutMs,
      "Agent setup timed out",
    )
    return agent
  }

  async #listProviderModels(provider: string): Promise<ProviderModel[]> {
    const cached = this.#providerModels.get(provider)
    if (cached && Date.now() - cached.cachedAt < this.#modelCacheTtlMs) return cached.models
    const agent = await this.#ensureAgentConnected(provider)
    if (!this.#providerModelRequests.has(provider)) {
      const discovery = agent.listModels().then((models) => {
        const parsed = rpcMethods["runtime.models"].result.parse(models)
          .filter((model) => model.provider === provider)
        if (parsed.length > 0) {
          this.#providerModels.set(provider, { models: parsed, cachedAt: Date.now() })
        }
        return parsed
      })
      this.#providerModelRequests.set(provider, discovery)
      void discovery.then(
        () => { if (this.#providerModelRequests.get(provider) === discovery) this.#providerModelRequests.delete(provider) },
        () => { if (this.#providerModelRequests.get(provider) === discovery) this.#providerModelRequests.delete(provider) },
      )
    }
    return withTimeout(
      this.#providerModelRequests.get(provider)!,
      this.#agentTimeoutMs,
      "Model discovery timed out",
    )
  }

  async #resolveRuntime(runtime: Runtime): Promise<Runtime> {
    let models: ProviderModel[]
    try {
      models = await this.#listProviderModels(runtime.provider)
    } catch (error) {
      if (error instanceof AgentProviderUnavailableError) {
        throw new RuntimeValidationError(error.message)
      }
      throw error
    }
    const model = runtime.model === "default"
      ? models.find((candidate) => candidate.isDefault) ?? models[0]
      : models.find((candidate) => candidate.id === runtime.model)
    if (!model) throw new RuntimeValidationError(`Model is not available from ${runtime.provider}`)
    const supportedReasoningEfforts = model.supportedReasoningEfforts.length > 0
      ? model.supportedReasoningEfforts
      : [model.defaultReasoningEffort]
    const reasoning = runtime.model === "default"
      && !supportedReasoningEfforts.includes(runtime.reasoning)
      ? model.defaultReasoningEffort
      : runtime.reasoning
    if (!supportedReasoningEfforts.includes(reasoning)) {
      throw new RuntimeValidationError("Reasoning effort is not supported by the selected model")
    }
    return { ...runtime, model: model.id, reasoning }
  }

  async #serveArtifact(url: string, response: import("node:http").ServerResponse): Promise<void> {
    let artifactId: string
    let bridgeChannel: string | undefined
    let parentOrigin: string | undefined
    let authorized = false
    try {
      const requestUrl = new URL(url, "http://domovoi.local")
      artifactId = decodeURIComponent(requestUrl.pathname.slice("/artifacts/".length))
      bridgeChannel = validPreviewBridgeChannel(requestUrl.searchParams.get("bridge"))
      parentOrigin = validPreviewParentOrigin(requestUrl.searchParams.get("parentOrigin"))
      const expiresAt = Number(requestUrl.searchParams.get("expires"))
      const signature = requestUrl.searchParams.get("signature")
      authorized = artifactAccessMatches(
        this.#artifactSigningSecret,
        artifactId,
        bridgeChannel,
        expiresAt,
        signature,
      )
    } catch {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }
    if (!canServeArtifacts(this.host, authorized)) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }

    const artifact = this.#snapshot.artifacts.find(
      (candidate) => candidate.id === artifactId && candidate.type === "preview",
    )
    const session = artifact
      ? this.#snapshot.sessions.find((candidate) => candidate.id === artifact.sessionId)
      : undefined
    const path = artifact?.path && session?.workspacePath
      ? await resolveInsideReal(session.workspacePath, artifact.path)
      : undefined
    if (!artifact || artifact.mimeType !== "text/html" || !path) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }

    try {
      const content = await readFile(path, "utf8")
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors ${frameAncestorsFor(this.allowedOrigins)}`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      })
      response.end(
        bridgeChannel && parentOrigin
          ? injectPreviewBridge(content, artifact.id, bridgeChannel, parentOrigin)
          : content,
      )
    } catch {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
    }
  }

  async #handle(socket: WebSocket, raw: string): Promise<void> {
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      this.#error(socket, null, invalidRequest, "Request is not valid JSON")
      return
    }

    const requestResult = rpcRequestSchema.safeParse(input)
    if (!requestResult.success) {
      this.#error(socket, null, invalidRequest, "Request does not match JSON-RPC 2.0")
      return
    }

    const request = requestResult.data
    if (!(request.method in rpcMethods)) {
      this.#error(socket, request.id, methodNotFound, `Unknown method: ${request.method}`)
      return
    }

    const method = request.method as RpcMethod
    const paramsResult = rpcMethods[method].params.safeParse(request.params ?? {})
    if (!paramsResult.success) {
      this.#error(socket, request.id, invalidParams, "Method parameters are invalid")
      return
    }

    if (this.#authToken && !this.#authenticatedClients.has(socket)) {
      if (method !== "system.hello") {
        this.#rejectAuthentication(socket, request.id, "Daemon authentication required")
        return
      }
      const supplied = "authToken" in paramsResult.data ? paramsResult.data.authToken : undefined
      if (!secureTokenMatch(this.#authToken, supplied)) {
        this.#rejectAuthentication(socket, request.id, "Daemon authentication failed")
        return
      }
      this.#authenticatedClients.add(socket)
      const deadline = this.#authenticationDeadlines.get(socket)
      if (deadline) clearTimeout(deadline)
      this.#authenticationDeadlines.delete(socket)
    }

    try {
      let changed = false
      if (method === "terminal.create") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!session?.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        const existing = this.#terminals.get(params.terminalId)
        if (existing) {
          if (existing.sessionId !== session.id) {
            this.#error(socket, request.id, invalidParams, "Terminal belongs to another session")
            return
          }
          if (existing.owner.clientId === params.clientId) {
            existing.process.resize(params.cols, params.rows)
            existing.cols = params.cols
            existing.rows = params.rows
          }
          this.#send(socket, {
            jsonrpc: "2.0",
            id: request.id,
            result: rpcMethods[method].result.parse({
              terminalId: params.terminalId,
              sessionId: existing.sessionId,
              cols: existing.cols,
              rows: existing.rows,
              shell: existing.shell,
              cwd: existing.cwd,
              buffer: existing.buffer,
              owner: existing.owner,
            }),
          })
          return
        }
        const process = this.#terminalService.spawn({
          cwd: session.workspacePath,
          cols: params.cols,
          rows: params.rows,
        })
        const activeTerminal: ActiveTerminal = {
          sessionId: session.id,
          process,
          cols: params.cols,
          rows: params.rows,
          shell: process.process,
          cwd: session.workspacePath,
          buffer: "",
          owner: { client: params.client, clientId: params.clientId },
          disposeData: () => {},
          disposeExit: () => {},
        }
        this.#terminals.set(params.terminalId, activeTerminal)
        const dataDisposable = process.onData((data) => {
          const active = this.#terminals.get(params.terminalId)
          if (active?.process === process) {
            active.buffer = `${active.buffer}${data}`.slice(-maximumTerminalBufferLength)
          }
          this.#broadcastNotification("terminal.output", {
            terminalId: params.terminalId,
            data,
          })
        })
        const exitDisposable = process.onExit(({ exitCode, signal }) => {
          const active = this.#terminals.get(params.terminalId)
          if (!active || active.process !== process) return
          this.#terminals.delete(params.terminalId)
          active.disposeData()
          active.disposeExit()
          this.#broadcastNotification("terminal.closed", {
            terminalId: params.terminalId,
            exitCode,
            ...(signal === undefined ? {} : { signal }),
          })
        })
        activeTerminal.disposeData = () => dataDisposable.dispose()
        activeTerminal.disposeExit = () => exitDisposable.dispose()
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            terminalId: params.terminalId,
            sessionId: session.id,
            cols: params.cols,
            rows: params.rows,
            shell: process.process,
            cwd: session.workspacePath,
            buffer: activeTerminal.buffer,
            owner: activeTerminal.owner,
          }),
        })
        return
      }

      if (method === "terminal.claim") {
        const params = rpcMethods[method].params.parse(request.params)
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        terminal.owner = { client: params.client, clientId: params.clientId }
        const ownership = rpcMethods[method].result.parse({
          terminalId: params.terminalId,
          owner: terminal.owner,
        })
        this.#broadcastNotification("terminal.ownership", ownership)
        this.#send(socket, { jsonrpc: "2.0", id: request.id, result: ownership })
        return
      }

      if (method === "terminal.input") {
        const params = rpcMethods[method].params.parse(request.params)
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        terminal.process.write(params.data)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "terminal.resize") {
        const params = rpcMethods[method].params.parse(request.params)
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        terminal.process.resize(params.cols, params.rows)
        terminal.cols = params.cols
        terminal.rows = params.rows
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "terminal.close") {
        const params = rpcMethods[method].params.parse(request.params)
        const terminal = this.#terminals.get(params.terminalId)
        if (!terminal) {
          this.#error(socket, request.id, invalidParams, "Terminal does not exist")
          return
        }
        if (terminal.owner.clientId !== params.clientId) {
          this.#error(socket, request.id, invalidParams, "Terminal is owned by another client")
          return
        }
        this.#closeTerminal(params.terminalId)
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({ accepted: true }),
        })
        return
      }

      if (method === "artifact.authorize") {
        const params = rpcMethods[method].params.parse(request.params)
        const artifact = this.#snapshot.artifacts.find(
          (candidate) => candidate.id === params.artifactId && candidate.type === "preview",
        )
        if (!artifact || artifact.mimeType !== "text/html" || !artifact.path) {
          this.#error(socket, request.id, invalidParams, "Preview artifact does not exist")
          return
        }
        const expiresAt = Math.floor(Date.now() / 1_000) + this.#artifactAccessTtlSeconds
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse({
            artifactId: params.artifactId,
            ...(params.bridgeChannel ? { bridgeChannel: params.bridgeChannel } : {}),
            expiresAt,
            signature: signArtifactAccess(
              this.#artifactSigningSecret,
              params.artifactId,
              params.bridgeChannel,
              expiresAt,
            ),
          }),
        })
        return
      }

      if (method === "runtime.models") {
        const params = rpcMethods[method].params.parse(request.params)
        let models: ProviderModel[]
        try {
          models = await this.#listProviderModels(params.provider)
        } catch (error) {
          if (!(error instanceof AgentProviderUnavailableError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(models),
        })
        return
      }

      if (method === "skill.list") {
        const catalog = this.#skillCatalog ?? new FileSkillCatalog(
          skillRoots(homedir(), this.#snapshot.project?.path),
        )
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(await catalog.list()),
        })
        return
      }

      if (method === "system.pauseAll") {
        const params = rpcMethods[method].params.parse(request.params)
        changed = await this.#pauseSessions(this.#snapshot.sessions.filter(
          (session) => session.providerThreadId && session.activeTurnId,
        ), params.client)
      }

      if (method === "session.pause") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        changed = await this.#pauseSessions(
          session.providerThreadId && session.activeTurnId ? [session] : [],
          params.client,
        )
      }

      if (method === "annotation.create") {
        const params = rpcMethods[method].params.parse(request.params)
        const artifact = this.#snapshot.artifacts.find(
          (candidate) =>
            candidate.id === params.artifactId && candidate.sessionId === params.sessionId,
        )
        if (!artifact) {
          this.#error(socket, request.id, invalidParams, "Artifact does not belong to the session")
          return
        }
        const createdAt = new Date().toISOString()
        this.#snapshot.annotations.push({
          id: `annotation-${randomUUID()}`,
          sessionId: params.sessionId,
          artifactId: params.artifactId,
          ...(params.variantId ? { variantId: params.variantId } : {}),
          anchor: params.anchor,
          body: params.body,
          status: "open",
          origin: params.client,
          thread: [],
          createdAt,
          updatedAt: createdAt,
        })
        changed = true
      }

      if (method === "annotation.reply") {
        const params = rpcMethods[method].params.parse(request.params)
        const annotation = this.#snapshot.annotations.find(
          (candidate) => candidate.id === params.annotationId,
        )
        if (!annotation) {
          this.#error(socket, request.id, invalidParams, "Annotation does not exist")
          return
        }
        const createdAt = new Date().toISOString()
        annotation.thread.push({
          id: `annotation-reply-${randomUUID()}`,
          body: params.body,
          origin: params.client,
          createdAt,
        })
        annotation.updatedAt = createdAt
        changed = true
      }

      if (method === "annotation.setStatus") {
        const params = rpcMethods[method].params.parse(request.params)
        const annotation = this.#snapshot.annotations.find(
          (candidate) => candidate.id === params.annotationId,
        )
        if (!annotation) {
          this.#error(socket, request.id, invalidParams, "Annotation does not exist")
          return
        }
        const changedAt = new Date().toISOString()
        annotation.status = params.status
        annotation.statusChangedBy = params.client
        annotation.statusChangedAt = changedAt
        annotation.updatedAt = changedAt
        changed = true
      }

      if (method === "approval.resolve") {
        const params = rpcMethods[method].params.parse(request.params)
        const approval = this.#snapshot.approvals.find(
          (candidate) => candidate.id === params.approvalId,
        )
        if (!approval) {
          this.#error(socket, request.id, invalidParams, "Approval does not exist")
          return
        }
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === approval.sessionId,
        )
        if (approval.providerRequestId !== undefined && session) {
          this.#agents.require(session.runtime.provider)
            .resolveApproval(approval.providerRequestId, params.decision)
        }
        if (params.decision === "always-project") {
          const project = this.#snapshot.project
          if (!project) {
            this.#error(socket, request.id, internalError, "Approval has no open project")
            return
          }
          this.#snapshot.approvalRules.push({
            id: `rule-${approval.id}-${Date.now()}`,
            projectId: project.id,
            operation: approval.operation,
            command: approval.command,
            createdBy: params.client,
            createdAt: new Date().toISOString(),
          })
        }
        this.#snapshot.thread.push({
          id: `receipt-${approval.id}-${Date.now()}`,
          sessionId: approval.sessionId,
          kind: "receipt",
          decision: params.decision,
          operation: approval.operation,
          checkpoint: approval.checkpoint,
          client: params.client,
          ...(params.explanation ? { explanation: params.explanation } : {}),
          createdAt: new Date().toISOString(),
        })
        this.#snapshot.approvals = this.#snapshot.approvals.filter(
          (approval) => approval.id !== params.approvalId,
        )
        if (session) {
          session.state = params.decision === "deny" || params.decision === "deny-explain"
            ? "idle"
            : "active"
        }
        changed = true
      }

      if (method === "session.setRuntime") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        const providerChanged = params.runtime.provider !== session.runtime.provider
        if (providerChanged && (!session.workspacePath || !session.providerThreadId)) {
          this.#error(socket, request.id, invalidParams, "Session is not ready for provider handoff")
          return
        }
        if (providerChanged && session.activeTurnId) {
          this.#error(socket, request.id, invalidParams, "Stop the active turn before changing providers")
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        if (runtime.provider !== currentSession.runtime.provider) {
          if (!currentSession.workspacePath || !currentSession.providerThreadId) {
            this.#error(socket, request.id, invalidParams, "Session is not ready for provider handoff")
            return
          }
          const previousRuntime = currentSession.runtime
          const previousThreadId = currentSession.providerThreadId
          const nextAgent = await this.#ensureAgentConnected(runtime.provider)
          const nextThreadId = await withTimeout(
            nextAgent.startThread({ cwd: currentSession.workspacePath, runtime }),
            this.#agentTimeoutMs,
            "Provider handoff timed out",
          )
          const previousAgent = this.#agents.require(previousRuntime.provider)
          let checkpoint: Awaited<ReturnType<WorkspaceService["checkpoint"]>>
          try {
            checkpoint = await withTimeout(
              this.#workspaceService.checkpoint(currentSession.workspacePath, "before provider handoff"),
              this.#agentTimeoutMs,
              "Provider handoff checkpoint timed out",
            )
            await withTimeout(
              previousAgent.stopThread(previousThreadId),
              this.#agentTimeoutMs,
              "Previous provider cleanup timed out",
            )
          } catch (error) {
            try {
              await nextAgent.stopThread(nextThreadId)
            } catch (cleanupError) {
              console.error("Domovoi could not stop a failed handoff thread", cleanupError)
            }
            throw error
          }
          const createdAt = new Date().toISOString()
          currentSession.runtime = runtime
          currentSession.providerThreadId = nextThreadId
          currentSession.changedFiles = checkpoint.changedFiles.length
          currentSession.state = "idle"
          currentSession.updatedAt = createdAt
          this.#loadedAgentThreads.delete(providerThreadKey(previousRuntime.provider, previousThreadId))
          this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, nextThreadId))
          this.#snapshot.thread.push({
            id: `checkpoint-${randomUUID()}`,
            sessionId: currentSession.id,
            kind: "checkpoint",
            label: `${checkpoint.commit.slice(0, 8)} · before provider handoff`,
            createdAt,
          })
          const openAnnotationCount = this.#snapshot.annotations.filter(
            (annotation) => annotation.sessionId === currentSession.id && annotation.status === "open",
          ).length
          this.#snapshot.thread.push({
            id: `handoff-${randomUUID()}`,
            sessionId: currentSession.id,
            kind: "system",
            body: `Handed off ${previousRuntime.provider} / ${previousRuntime.model} to ${runtime.provider} / ${runtime.model}.`,
            detail: `Thread, plan, worktree, diff, test results, and ${openAnnotationCount} open annotations carried over. Hidden reasoning and provider caches did not transfer.`,
            createdAt,
          })
        } else {
          currentSession.runtime = runtime
        }
        changed = true
      }

      if (method === "project.open") {
        const params = rpcMethods[method].params.parse(request.params)
        const repository = await this.#workspaceService.inspect(params.path)
        this.#closeAllTerminals()
        await this.#cleanupSessions()
        const projectId = `project-${createHash("sha256").update(repository.root).digest("hex").slice(0, 12)}`
        this.#snapshot.project = {
          id: projectId,
          machineId: this.#snapshot.machine.id,
          name: repository.name,
          path: repository.root,
          branch: repository.branch,
        }
        this.#snapshot.sessions = []
        this.#snapshot.activeSessionId = null
        this.#snapshot.approvals = []
        this.#snapshot.approvalRules = []
        this.#snapshot.thread = []
        this.#snapshot.artifacts = []
        this.#snapshot.annotations = []
        changed = true
      }

      if (method === "session.activate") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session) {
          this.#error(socket, request.id, invalidParams, "Session does not exist")
          return
        }
        this.#snapshot.activeSessionId = session.id
        changed = true
      }

      if (method === "session.create") {
        const params = rpcMethods[method].params.parse(request.params)
        const project = this.#snapshot.project
        if (!project) {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Open a valid Git repository with project.open before creating a session",
          )
          return
        }
        try {
          await this.#workspaceService.inspect(project.path)
        } catch {
          this.#error(
            socket,
            request.id,
            invalidParams,
            "Open a valid Git repository with project.open before creating a session",
          )
          return
        }
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        const sessionId = `session-${randomUUID()}`
        const workspace = await this.#workspaceService.createSessionWorkspace(
          project.path,
          sessionId,
        )
        let providerThreadId: string
        try {
          const agent = this.#agents.require(runtime.provider)
          providerThreadId = await withTimeout(
            agent.startThread({ cwd: workspace.path, runtime }),
            this.#agentTimeoutMs,
            "Agent setup timed out",
          )
        } catch (error) {
          try {
            await this.#workspaceService.removeSessionWorkspace(workspace.path)
          } catch (cleanupError) {
            console.error("Domovoi could not remove a failed session worktree", cleanupError)
          }
          throw error
        }
        const createdAt = new Date().toISOString()
        this.#snapshot.sessions.push({
          id: sessionId,
          projectId: project.id,
          title: params.title,
          state: "idle",
          runtime,
          changedFiles: 0,
          testsPassed: 0,
          testsFailed: 0,
          updatedAt: createdAt,
          workspacePath: workspace.path,
          providerThreadId,
          baseCommit: workspace.baseCommit,
        })
        this.#loadedAgentThreads.add(providerThreadKey(runtime.provider, providerThreadId))
        this.#snapshot.activeSessionId = sessionId
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId,
          kind: "system",
          body: `Created isolated worktree ${workspace.branch}.`,
          detail: workspace.path,
          createdAt,
        })
        changed = true
      }

      if (method === "session.send") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session?.workspacePath || !session.providerThreadId) {
          this.#error(socket, request.id, invalidParams, "Session is not ready for agent turns")
          return
        }
        const createdAt = new Date().toISOString()
        const agent = await this.#ensureAgentConnected(session.runtime.provider)
        const loadedThread = providerThreadKey(session.runtime.provider, session.providerThreadId)
        if (!this.#loadedAgentThreads.has(loadedThread)) {
          await withTimeout(
            agent.resumeThread({
              threadId: session.providerThreadId,
              cwd: session.workspacePath,
              runtime: session.runtime,
            }),
            this.#agentTimeoutMs,
            "Agent thread resume timed out",
          )
          this.#loadedAgentThreads.add(loadedThread)
        }
        const prompt = agentPromptWithAnnotations(
          this.#snapshot,
          session.id,
          agentPromptWithHandoff(this.#snapshot, session.id, params.prompt),
        )
        const turnId = session.activeTurnId ?? await withTimeout(
          agent.startTurn({
            threadId: session.providerThreadId,
            cwd: session.workspacePath,
            prompt,
            runtime: session.runtime,
          }),
          this.#agentTimeoutMs,
          "Agent turn timed out",
        )
        if (session.activeTurnId) {
          await withTimeout(
            agent.steerTurn(session.providerThreadId, session.activeTurnId, prompt),
            this.#agentTimeoutMs,
            "Agent steering timed out",
          )
        }
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        this.#snapshot.thread.push({
          id: `user-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "user",
          body: params.prompt,
          createdAt,
        })
        currentSession.state = "active"
        currentSession.updatedAt = createdAt
        currentSession.activeTurnId = turnId
        this.#snapshot.activeSessionId = currentSession.id
        changed = true
      }

      if (method === "checkpoint.create") {
        const params = rpcMethods[method].params.parse(request.params)
        const session = this.#snapshot.sessions.find((candidate) => candidate.id === params.sessionId)
        if (!session?.workspacePath) {
          this.#error(socket, request.id, invalidParams, "Session has no worktree")
          return
        }
        const label = params.label ?? "manual"
        const checkpoint = await withTimeout(
          this.#workspaceService.checkpoint(session.workspacePath, label),
          this.#agentTimeoutMs,
          "Checkpoint timed out",
        )
        const currentSession = this.#snapshot.sessions.find(
          (candidate) => candidate.id === params.sessionId,
        )
        if (!currentSession) {
          this.#error(socket, request.id, invalidParams, "Session no longer exists")
          return
        }
        currentSession.changedFiles = checkpoint.changedFiles.length
        currentSession.updatedAt = new Date().toISOString()
        this.#snapshot.thread.push({
          id: `checkpoint-${randomUUID()}`,
          sessionId: currentSession.id,
          kind: "checkpoint",
          label: `${checkpoint.commit.slice(0, 8)} · ${label}`,
          createdAt: currentSession.updatedAt,
        })
        changed = true
      }

      this.#snapshot = workspaceSnapshotSchema.parse(this.#snapshot)
      if (changed) this.#store.save(this.#snapshot)
      this.#send(socket, { jsonrpc: "2.0", id: request.id, result: this.#snapshot })

      if (changed) this.#broadcastSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown daemon error"
      this.#error(socket, request.id, internalError, message)
    }
  }

  async #handleAgentEvent(provider: string, event: AgentEvent): Promise<void> {
    let threadId: string | undefined
    if ("threadId" in event) threadId = event.threadId
    else if ("params" in event && typeof event.params.threadId === "string") {
      threadId = event.params.threadId
    }
    const session = this.#snapshot.sessions.find(
      (candidate) => candidate.runtime.provider === provider && candidate.providerThreadId === threadId,
    )
    if (!session) return
    const eventTurnId = turnIdForAgentEvent(event)
    if (eventTurnId && eventTurnId !== session.activeTurnId) return
    const createdAt = new Date().toISOString()

    if (event.type === "text-delta") {
      const itemId = `assistant-message-${event.turnId ?? session.id}`
      const existing = this.#snapshot.thread.find(
        (item) => item.id === itemId && item.kind === "assistant",
      )
      if (existing?.kind === "assistant") existing.body += event.delta
      else this.#snapshot.thread.push({
        id: itemId,
        sessionId: session.id,
        kind: "assistant",
        body: event.delta,
        createdAt,
      })
    }

    if (event.type === "plan-delta") {
      appendPlanDelta(
        this.#snapshot.artifacts,
        this.#snapshot.annotations,
        session.id,
        event.delta,
      )
    }

    if (event.type === "command-output") {
      const itemId = `tool-${event.itemId ?? event.turnId ?? randomUUID()}`
      const existing = this.#snapshot.thread.find((item) => item.id === itemId)
      if (existing?.kind === "tool") existing.output = `${existing.output ?? ""}${event.delta}`
      else this.#snapshot.thread.push({
        id: itemId,
        sessionId: session.id,
        kind: "tool",
        tool: "command",
        status: "running",
        title: "Command output",
        output: event.delta,
        createdAt,
      })
    }

    if (event.type === "diff-updated") {
      const artifactId = `diff-${session.id}`
      const existing = this.#snapshot.artifacts.find((artifact) => artifact.id === artifactId)
      if (existing) {
        existing.content = event.diff
        existing.revision += 1
      } else {
        this.#snapshot.artifacts.push({
          id: artifactId,
          sessionId: session.id,
          title: "Working changes",
          type: "diff",
          revision: 1,
          mimeType: "text/x-diff",
          content: event.diff,
        })
      }
    }

    if (event.type === "approval-requested") {
      const project = this.#snapshot.project
      if (!project) return
      const matchingRule = this.#snapshot.approvalRules.find(
        (rule) => rule.projectId === project.id && rule.command === event.command,
      )
      if (matchingRule) {
        this.#agents.require(provider).resolveApproval(event.requestId, "always-project")
      } else {
        this.#snapshot.approvals.push({
          id: `approval-${randomUUID()}`,
          sessionId: session.id,
          risk: /\b(migrate|deploy|delete|drop)\b/i.test(event.command ?? "") ? "hard-gate" : "normal",
          operation: event.reason ?? "Run a command",
          command: event.command ?? "Command details unavailable",
          machine: this.#snapshot.machine.name,
          agent: `${session.runtime.provider} / ${session.runtime.model}`,
          mode: session.runtime.permissionMode,
          directory: event.cwd ?? session.workspacePath ?? project.path,
          affects: "Files and processes in the session worktree.",
          network: "No agent network access granted.",
          estimatedDuration: "Unknown",
          checkpoint: session.baseCommit ?? "unavailable",
          providerRequestId: event.requestId,
          requestedAt: createdAt,
        })
        session.state = "waiting"
      }
    }

    if (event.type === "item") {
      const item = event.params.item
      if (item && typeof item === "object" && "type" in item && item.type === "commandExecution") {
        const commandItem = item as Record<string, unknown>
        const id = `tool-${String(commandItem.id ?? randomUUID())}`
        const command = Array.isArray(commandItem.command)
          ? commandItem.command.join(" ")
          : String(commandItem.command ?? "Command")
        const status = commandItem.status === "failed"
          ? "failed"
          : commandItem.status === "declined"
            ? "declined"
            : event.phase === "completed"
              ? "completed"
              : "running"
        const existing = this.#snapshot.thread.find((threadItem) => threadItem.id === id)
        if (existing?.kind === "tool") {
          existing.status = status
          existing.title = command
          if (typeof commandItem.aggregatedOutput === "string") {
            existing.output = commandItem.aggregatedOutput
          }
        } else {
          this.#snapshot.thread.push({
            id,
            sessionId: session.id,
            kind: "tool",
            tool: "command",
            status,
            title: command,
            ...(typeof commandItem.aggregatedOutput === "string"
              ? { output: commandItem.aggregatedOutput }
              : {}),
            createdAt,
          })
        }
      }
      if (item && typeof item === "object" && "type" in item && item.type === "fileChange") {
        const fileChange = item as Record<string, unknown>
        const changes = Array.isArray(fileChange.changes) ? fileChange.changes : []
        for (const change of changes) {
          if (!change || typeof change !== "object" || !("path" in change)) continue
          const path = String(change.path)
          if (!path.toLowerCase().endsWith(".html") || !session.workspacePath) continue
          const lexicalPath = resolveInside(session.workspacePath, path)
          if (!lexicalPath || !await resolveInsideReal(session.workspacePath, lexicalPath)) continue
          const artifactId = `preview-${createHash("sha256")
            .update(`${session.id}:${lexicalPath}`)
            .digest("hex")
            .slice(0, 16)}`
          const existing = this.#snapshot.artifacts.find(
            (artifact) => artifact.id === artifactId,
          )
          if (existing) existing.revision += 1
          else this.#snapshot.artifacts.push({
            id: artifactId,
            sessionId: session.id,
            title: basename(lexicalPath),
            type: "preview",
            revision: 1,
            path: lexicalPath,
            mimeType: "text/html",
          })
        }
      }
    }

    if (event.type === "turn-completed") {
      const turn = event.params.turn
      const failed = turn && typeof turn === "object" && "status" in turn && turn.status === "failed"
      session.state = failed ? "failed" : "idle"
      delete session.activeTurnId
    }

    session.updatedAt = createdAt
    if (
      event.type === "text-delta" ||
      event.type === "plan-delta" ||
      event.type === "command-output"
    ) {
      this.#scheduleDeltaFlush()
    } else {
      this.#flushAgentState()
    }
  }

  async #pauseSessions(
    active: WorkspaceSnapshot["sessions"],
    client: ClientKind,
  ): Promise<boolean> {
    const results = await Promise.allSettled(active.map(async (session) =>
      withTimeout(
        this.#agents.require(session.runtime.provider)
          .interruptTurn(session.providerThreadId!, session.activeTurnId!),
        this.#agentTimeoutMs,
        "Agent interrupt timed out",
      ),
    ))
    const createdAt = new Date().toISOString()
    results.forEach((result, index) => {
      const session = active[index]!
      session.updatedAt = createdAt
      if (result.status === "fulfilled") {
        session.state = "idle"
        delete session.activeTurnId
        this.#snapshot.approvals = this.#snapshot.approvals.filter(
          (approval) => approval.sessionId !== session.id,
        )
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId: session.id,
          kind: "system",
          body: `Paused by ${client}.`,
          createdAt,
        })
      } else {
        this.#snapshot.thread.push({
          id: `system-${randomUUID()}`,
          sessionId: session.id,
          kind: "system",
          body: `Pause failed for ${client}.`,
          detail: result.reason instanceof Error ? result.reason.message : "Unknown provider error",
          createdAt,
        })
      }
    })
    return active.length > 0
  }

  #rejectAuthentication(
    socket: WebSocket,
    id: string | number | null,
    message: string,
  ): void {
    this.#error(socket, id, daemonAuthenticationErrorCode, message)
    const failures = (this.#authenticationFailures.get(socket) ?? 0) + 1
    this.#authenticationFailures.set(socket, failures)
    if (failures >= maximumAuthenticationFailures) {
      setTimeout(() => socket.close(1008, "authentication failed"), 0)
    }
  }

  #closeTerminal(terminalId: string): boolean {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal) return false
    this.#terminals.delete(terminalId)
    terminal.disposeData()
    terminal.disposeExit()
    terminal.process.kill()
    this.#broadcastNotification("terminal.closed", { terminalId })
    return true
  }

  #closeAllTerminals(): void {
    for (const terminalId of [...this.#terminals.keys()]) this.#closeTerminal(terminalId)
  }

  #scheduleDeltaFlush(): void {
    if (this.#deltaFlush) clearTimeout(this.#deltaFlush)
    this.#deltaFlush = setTimeout(() => {
      this.#deltaFlush = undefined
      this.#flushAgentState()
    }, 32)
  }

  #flushAgentState(): void {
    if (this.#deltaFlush) {
      clearTimeout(this.#deltaFlush)
      this.#deltaFlush = undefined
    }
    try {
      this.#snapshot = workspaceSnapshotSchema.parse(this.#snapshot)
      this.#store.save(this.#snapshot)
      this.#broadcastSnapshot()
    } catch (error) {
      console.error("Domovoi could not persist agent state", error)
    }
  }

  async #cleanupSessions(): Promise<void> {
    const errors: unknown[] = []
    for (const session of this.#snapshot.sessions) {
      if (session.providerThreadId) {
        try {
          await withTimeout(
            this.#agents.require(session.runtime.provider).stopThread(session.providerThreadId),
            this.#agentTimeoutMs,
            "Agent cleanup timed out",
          )
        } catch (error) {
          errors.push(error)
          console.error("Domovoi could not stop a provider thread", error)
        }
        this.#loadedAgentThreads.delete(
          providerThreadKey(session.runtime.provider, session.providerThreadId),
        )
      }
      if (session.workspacePath) {
        try {
          await this.#workspaceService.removeSessionWorkspace(session.workspacePath)
        } catch (error) {
          errors.push(error)
          console.error("Domovoi could not remove a session worktree", error)
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Domovoi could not clean up all sessions")
  }
}

function turnIdForAgentEvent(event: AgentEvent): string | undefined {
  if ("turnId" in event && typeof event.turnId === "string") return event.turnId
  if (!("params" in event)) return undefined
  if (typeof event.params.turnId === "string") return event.params.turnId
  const turn = event.params.turn
  if (turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string") {
    return turn.id
  }
  return undefined
}

function providerThreadKey(provider: string, threadId: string): string {
  return `${provider}\u0000${threadId}`
}

function secureTokenMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

export function canServeArtifacts(host: string, authorized = false): boolean {
  return isLoopbackHost(host) || authorized
}

export function frameAncestorsFor(origins: Iterable<string>): string {
  const sources: string[] = []
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === "file:") sources.push("file:")
      else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        sources.push(parsed.origin)
      }
    } catch {
      continue
    }
  }
  return sources.length > 0 ? [...new Set(sources)].join(" ") : "'none'"
}

function artifactAccessPayload(
  artifactId: string,
  bridgeChannel: string | undefined,
  expiresAt: number,
): string {
  return JSON.stringify([artifactId, bridgeChannel ?? null, expiresAt])
}

export function signArtifactAccess(
  secret: string,
  artifactId: string,
  bridgeChannel: string | undefined,
  expiresAt: number,
): string {
  return createHmac("sha256", secret)
    .update(artifactAccessPayload(artifactId, bridgeChannel, expiresAt))
    .digest("base64url")
}

export function artifactAccessMatches(
  secret: string,
  artifactId: string,
  bridgeChannel: string | undefined,
  expiresAt: number,
  suppliedSignature: string | null,
  now = Math.floor(Date.now() / 1_000),
): boolean {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || typeof suppliedSignature !== "string") {
    return false
  }
  return secureTokenMatch(
    signArtifactAccess(secret, artifactId, bridgeChannel, expiresAt),
    suppliedSignature,
  )
}

export function hostAuthorityMatches(
  authority: string,
  listenerHost: string,
  listenerPort: number,
): boolean {
  if (/[@/?#\\\\]/.test(authority)) return false
  let parsed: URL
  try {
    parsed = new URL(`http://${authority}`)
  } catch {
    return false
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
  const authorityPort = parsed.port === "" ? 80 : Number(parsed.port)
  if (authorityPort !== listenerPort) return false
  if (hostname === listenerHost) return true
  return hostname === "localhost" && isLoopbackHost(listenerHost)
}

function resolveInside(root: string, candidate: string): string | undefined {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(resolvedRoot, candidate)
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate)
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    return resolvedCandidate
  }
  return undefined
}

async function resolveInsideReal(root: string, candidate: string): Promise<string | undefined> {
  const lexicalPath = resolveInside(root, candidate)
  if (!lexicalPath) return undefined
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexicalPath)])
    return resolveInside(realRoot, realCandidate)
  } catch {
    return undefined
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}
