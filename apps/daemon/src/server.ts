import { createServer, type Server as HttpServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { arch, homedir, hostname, platform } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  rpcMethods,
  rpcRequestSchema,
  workspaceSnapshotSchema,
  type Annotation,
  type Artifact,
  type ProviderModel,
  type RpcMethod,
  type Runtime,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from "ws"

import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import {
  CodexAppServerAdapter,
  type AgentAdapter,
  type AgentEvent,
} from "./codex.js"
import { GitWorkspaceService, type WorkspaceService } from "./workspace.js"
import {
  injectPreviewBridge,
  validPreviewBridgeChannel,
  validPreviewParentOrigin,
} from "./preview-bridge.js"
import { agentPromptWithAnnotations } from "./annotation-context.js"

const invalidRequest = -32600
const methodNotFound = -32601
const invalidParams = -32602
const internalError = -32603

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
  workspaceService?: WorkspaceService
  worktreeRoot?: string
  agentTimeoutMs?: number
  modelCacheTtlMs?: number
}

export class DomovoiDaemon {
  readonly host: string
  readonly requestedPort: number
  readonly allowedOrigins: ReadonlySet<string>
  #http: HttpServer | undefined
  #websocket: WebSocketServer | undefined
  #snapshot: WorkspaceSnapshot
  #store: WorkspaceStore
  #agent: AgentAdapter
  #workspaceService: WorkspaceService
  #agentConnected = false
  #agentConnection: Promise<void> | undefined
  #providerModels: ProviderModel[] | undefined
  #providerModelsCachedAt = 0
  #providerModelsRequest: Promise<ProviderModel[]> | undefined
  #unsubscribeAgent: () => void
  #mutationQueue = Promise.resolve()
  #deltaFlush: ReturnType<typeof setTimeout> | undefined
  #agentTimeoutMs: number
  #modelCacheTtlMs: number

  constructor(options: DaemonServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
    this.requestedPort = options.port ?? 47831
    this.#modelCacheTtlMs = Math.max(0, options.modelCacheTtlMs ?? 60_000)
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
    })
    this.#store = options.store ?? new SqliteWorkspaceStore(
      options.statePath ?? join(homedir(), ".domovoi", "state.sqlite"),
      initialSnapshot,
      { legacySnapshots: [demoWorkspace] },
    )
    this.#snapshot = this.#store.load()
    this.#agent = options.agent ?? new CodexAppServerAdapter()
    this.#workspaceService = options.workspaceService ?? new GitWorkspaceService(
      options.worktreeRoot ?? join(homedir(), ".domovoi", "worktrees"),
    )
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 30_000
    this.#unsubscribeAgent = this.#agent.onEvent((event) => {
      this.#enqueueMutation(() => this.#handleAgentEvent(event))
    })
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
      socket.on("message", (data) => {
        const raw = data.toString()
        if (this.#isModelDiscovery(raw)) void this.#handle(socket, raw)
        else this.#enqueueMutation(() => this.#handle(socket, raw))
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.#http!.once("error", reject)
      this.#http!.listen(this.requestedPort, this.host, () => resolve())
    })

    return this.address!
  }

  async stop(): Promise<void> {
    for (const client of this.#websocket?.clients ?? []) client.close(1001, "daemon stopping")

    await new Promise<void>((resolve, reject) => {
      if (!this.#http) return resolve()
      this.#http.close((error) => (error ? reject(error) : resolve()))
    })

    this.#websocket = undefined
    this.#http = undefined
    await this.#mutationQueue
    if (this.#deltaFlush) this.#flushAgentState()
    this.#unsubscribeAgent()
    await this.#agent.close()
    this.#store.close()
  }

  #send(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload))
  }

  #broadcastSnapshot(): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: this.#snapshot,
    })

    for (const client of this.#websocket?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(message)
    }
  }

  #error(socket: WebSocket, id: string | number | null, code: number, message: string): void {
    this.#send(socket, { jsonrpc: "2.0", id, error: { code, message } })
  }

  #acceptsHost(host: string | undefined): boolean {
    const address = this.address
    if (!host || !address) return false
    const accepted = new Set([`${address.host}:${address.port}`])
    if (address.host === "127.0.0.1") accepted.add(`localhost:${address.port}`)
    return accepted.has(host)
  }

  #enqueueMutation(task: () => Promise<void>): void {
    this.#mutationQueue = this.#mutationQueue.then(task).catch((error: unknown) => {
      console.error("Domovoi mutation failed", error)
    })
  }

  #isModelDiscovery(raw: string): boolean {
    try {
      const request = JSON.parse(raw) as { method?: unknown }
      return request.method === "runtime.models"
    } catch {
      return false
    }
  }

  async #ensureAgentConnected(): Promise<void> {
    if (this.#agentConnected) return
    if (!this.#agentConnection) {
      const connection = this.#agent.connect().then(() => {
        this.#agentConnected = true
      })
      this.#agentConnection = connection
      void connection.then(
        () => { if (this.#agentConnection === connection) this.#agentConnection = undefined },
        () => { if (this.#agentConnection === connection) this.#agentConnection = undefined },
      )
    }
    await withTimeout(this.#agentConnection, this.#agentTimeoutMs, "Agent setup timed out")
  }

  async #listProviderModels(): Promise<ProviderModel[]> {
    if (
      this.#providerModels
      && Date.now() - this.#providerModelsCachedAt < this.#modelCacheTtlMs
    ) return this.#providerModels
    await this.#ensureAgentConnected()
    if (!this.#providerModelsRequest) {
      const discovery = this.#agent.listModels().then((models) => {
        const parsed = rpcMethods["runtime.models"].result.parse(models)
          .filter((model) => model.provider === "codex")
        if (parsed.length > 0) {
          this.#providerModels = parsed
          this.#providerModelsCachedAt = Date.now()
        }
        return parsed
      })
      this.#providerModelsRequest = discovery
      void discovery.then(
        () => { if (this.#providerModelsRequest === discovery) this.#providerModelsRequest = undefined },
        () => { if (this.#providerModelsRequest === discovery) this.#providerModelsRequest = undefined },
      )
    }
    return withTimeout(
      this.#providerModelsRequest,
      this.#agentTimeoutMs,
      "Model discovery timed out",
    )
  }

  async #resolveRuntime(runtime: Runtime): Promise<Runtime> {
    if (runtime.provider !== "codex") {
      throw new RuntimeValidationError("Only the Codex provider is available")
    }
    const models = await this.#listProviderModels()
    const model = runtime.model === "default"
      ? models.find((candidate) => candidate.isDefault) ?? models[0]
      : models.find((candidate) => candidate.id === runtime.model)
    if (!model) throw new RuntimeValidationError("Model is not available from Codex")
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
    try {
      const requestUrl = new URL(url, "http://domovoi.local")
      artifactId = decodeURIComponent(requestUrl.pathname.slice("/artifacts/".length))
      bridgeChannel = validPreviewBridgeChannel(requestUrl.searchParams.get("bridge"))
      parentOrigin = validPreviewParentOrigin(requestUrl.searchParams.get("parentOrigin"))
    } catch {
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
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors http://127.0.0.1:5178 http://localhost:5178 file:",
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

    try {
      let changed = false
      if (method === "runtime.models") {
        const models = await this.#listProviderModels()
        this.#send(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: rpcMethods[method].result.parse(models),
        })
        return
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
        if (approval.providerRequestId !== undefined) {
          this.#agent.resolveApproval(approval.providerRequestId, params.decision)
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
        const session = this.#snapshot.sessions.find(
          (candidate) => candidate.id === this.#snapshot.activeSessionId,
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
        let runtime: Runtime
        try {
          runtime = await this.#resolveRuntime(params.runtime)
        } catch (error) {
          if (!(error instanceof RuntimeValidationError)) throw error
          this.#error(socket, request.id, invalidParams, error.message)
          return
        }
        session.runtime = runtime
        changed = true
      }

      if (method === "project.open") {
        const params = rpcMethods[method].params.parse(request.params)
        const repository = await this.#workspaceService.inspect(params.path)
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
          providerThreadId = await withTimeout(
            this.#agent.startThread({ cwd: workspace.path, runtime }),
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
        const turnId = await withTimeout(
          this.#agent.startTurn({
            threadId: session.providerThreadId,
            cwd: session.workspacePath,
            prompt: agentPromptWithAnnotations(this.#snapshot, session.id, params.prompt),
            runtime: session.runtime,
          }),
          this.#agentTimeoutMs,
          "Agent turn timed out",
        )
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

  async #handleAgentEvent(event: AgentEvent): Promise<void> {
    let threadId: string | undefined
    if ("threadId" in event) threadId = event.threadId
    else if ("params" in event && typeof event.params.threadId === "string") {
      threadId = event.params.threadId
    }
    const session = this.#snapshot.sessions.find(
      (candidate) => candidate.providerThreadId === threadId,
    )
    if (!session) return
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
        this.#agent.resolveApproval(event.requestId, "always-project")
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
            this.#agent.stopThread(session.providerThreadId),
            this.#agentTimeoutMs,
            "Agent cleanup timed out",
          )
        } catch (error) {
          errors.push(error)
          console.error("Domovoi could not stop a provider thread", error)
        }
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
