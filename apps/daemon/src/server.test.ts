import { access, mkdir, mkdtemp, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { createHash } from "node:crypto"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createEmptyWorkspace,
  demoWorkspace,
  machineIdSchema,
  maximumEffectiveClientThreadItems,
  maximumTerminalOutputChunkCharacters,
  maximumWorkspaceDeltaChunkLength,
  projectSwitchConfirmationSchema,
  workspaceSnapshotSchema,
  type ProviderModel,
  type RpcMethod,
  type RpcResult,
  type SkillSummary,
} from "@getdomovoi/protocol"

import {
  maximumIncomingTransfers,
  appendPlanDelta,
  artifactAccessMatches,
  canServeArtifacts,
  frameAncestorsFor,
  DomovoiDaemon,
  hostAuthorityMatches,
  isTestCommandTitle,
  maximumAuthenticationPayloadBytes,
  maximumCachedSessionHistoryFilterEntries,
  maximumWebSocketPayloadBytes,
  protectedAnnotationCropRefs,
  SessionHistoryIndex,
  sessionHistoryEntries,
  sessionHistoryPage,
  signArtifactAccess,
  workspaceSnapshotForClient,
  workspaceDeltaChunks,
} from "./server.js"
import {
  retryableSlowClientCloseCode,
  retryableSlowClientCloseReason,
  rpcWebSocketHighWaterBytes,
} from "./rpc-outbound.js"
import type { AgentAdapter, AgentEvent } from "./codex.js"
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import { SkillNotFoundError, type SkillCatalog } from "./skills.js"
import { WorkspaceEvidenceUnstableError, type WorkspaceService } from "./workspace.js"
import type { AuditLog } from "./audit-log.js"
import type { ProviderSecretStatus } from "./provider-secrets.js"
import type { ArtifactWatcherOptions } from "./artifact-watcher.js"
import { maximumPrintableArtifactDepth } from "./print-artifact.js"

const skillSecurityMetadata = {
  manifest: { version: 1 as const, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" as const },
  trust: { state: "untrusted" as const, reason: "unsigned" as const },
}

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []
type TestRpcResponse<M extends RpcMethod> = Record<string, unknown> & { result: RpcResult<M> }

function deferLiveTurns(snapshot: typeof demoWorkspace): () => void {
  const turns = snapshot.sessions.flatMap((session) => session.activeTurnId
    ? [{ sessionId: session.id, state: session.state, activeTurnId: session.activeTurnId }]
    : [])
  const affected = new Set(turns.map(({ sessionId }) => sessionId))
  const approvals = snapshot.approvals.filter((approval) => affected.has(approval.sessionId))
  for (const turn of turns) {
    const session = snapshot.sessions.find(({ id }) => id === turn.sessionId)!
    session.state = "idle"
    delete session.activeTurnId
  }
  snapshot.approvals = snapshot.approvals.filter((approval) => !affected.has(approval.sessionId))
  return () => {
    for (const turn of turns) {
      const session = snapshot.sessions.find(({ id }) => id === turn.sessionId)!
      session.state = turn.state
      session.activeTurnId = turn.activeTurnId
    }
    snapshot.approvals.push(...approvals)
  }
}

function authenticatedSocket(daemon: DomovoiDaemon, url: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
}

function identifyClient(
  socket: WebSocket,
  client: "desktop" | "web" = "desktop",
  clientId = `${client}-test-client`,
): Promise<void> {
  return new Promise((resolve) => {
    const id = "test-client-identity"
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: string }
      if (message.id !== id) return
      socket.off("message", receive)
      resolve()
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "system.hello",
      params: { client, clientId, clientVersion: "0.0.1" },
    }))
  })
}

const codexModels = () => [{
  provider: "codex" as const,
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "Coding model",
  supportedReasoningEfforts: ["none", "medium", "high", "xhigh", "max"],
  defaultReasoningEffort: "xhigh",
  isDefault: true,
}]

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("DomovoiDaemon", () => {
  it("closes a client whose RPC response reaches the outbound high-water boundary", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", structuredClone(demoWorkspace)),
      agents: {},
      rpcOutboundBackpressure: {
        bufferedBytes: () => rpcWebSocketHighWaterBytes,
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const outcome = new Promise<{ kind: "message"; value: unknown } | { kind: "close"; code: number; reason: string }>(
      (resolve) => {
        socket.once("message", (data) => resolve({ kind: "message", value: JSON.parse(data.toString()) }))
        socket.once("close", (code, reason) => resolve({ kind: "close", code, reason: reason.toString() }))
      },
    )

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace.get", params: {} }))

    await expect(outcome).resolves.toEqual({
      kind: "close",
      code: retryableSlowClientCloseCode,
      reason: retryableSlowClientCloseReason,
    })
  })

  it("bypasses ordinary pressure policy for terminal notifications", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const workspacePath = await mkdtemp(join(tmpdir(), "domovoi-terminal-backpressure-"))
    scratchDirectories.push(workspacePath)
    session.workspacePath = workspacePath
    const output = "x".repeat(maximumTerminalOutputChunkCharacters)
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        listener(output)
        return { dispose: vi.fn() }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agents: {},
      terminalService: { spawn: vi.fn(() => terminal) },
      rpcOutboundBackpressure: {
        bufferedBytes: () => rpcWebSocketHighWaterBytes,
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const messages: Array<{ method?: string; id?: number; params?: { data?: string } }> = []
    const outcome = new Promise<"response" | { code: number; reason: string }>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        messages.push(message)
        if (message.id === 1) resolve("response")
      })
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "terminal.create",
      params: {
        terminalId: "terminal-backpressure",
        sessionId: session.id,
        cols: 80,
        rows: 24,
        client: "desktop",
        clientId: "desktop-backpressure",
      },
    }))

    await expect(outcome).resolves.toEqual({
      code: retryableSlowClientCloseCode,
      reason: retryableSlowClientCloseReason,
    })
    expect(messages).toEqual([expect.objectContaining({
      method: "terminal.output",
      params: { terminalId: "terminal-backpressure", data: output },
    })])
  })

  it("awaits async long-history persistence without starving timers", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread = Array.from({ length: 4_000 }, (_, index) => ({
      id: `long-history-${index}`,
      sessionId: snapshot.sessions[0]!.id,
      kind: "user" as const,
      body: `message-${index}-${"x".repeat(1_024)}`,
      createdAt: "2026-08-30T12:00:00.000Z",
    }))
    let durable = false
    const save = vi.fn(() => { throw new Error("synchronous persistence used") })
    const saveAsync = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      durable = true
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save, saveAsync, close: vi.fn() },
      agents: {},
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let heartbeats = 0
    const heartbeat = setInterval(() => { heartbeats += 1 }, 1)
    const startedAt = performance.now()
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.activate",
      params: { sessionId: snapshot.sessions[1]!.id, client: "desktop" },
    }))

    await expect(response).resolves.toMatchObject({
      result: { activeSessionId: snapshot.sessions[1]!.id },
    })
    const elapsedMs = performance.now() - startedAt
    clearInterval(heartbeat)
    expect(durable).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(saveAsync).toHaveBeenCalledOnce()
    // Timers must keep firing during persistence. The count stays low because
    // Windows resolves timers to roughly 15 ms, so this asserts they ran at
    // all rather than a rate the platform does not promise.
    expect(heartbeats).toBeGreaterThanOrEqual(2)
    expect(elapsedMs).toBeLessThan(500)
    socket.close()
  })

  it("protects only valid crop references retained by annotations", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.annotations[0]!.visualContext = {
      status: "available",
      ref: `crop-${"a".repeat(64)}`,
      artifactRevision: 1,
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteLength: 8,
    }
    snapshot.annotations[1]!.visualContext = {
      status: "available",
      ref: "../../invalid",
      artifactRevision: 1,
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteLength: 8,
    }
    expect(protectedAnnotationCropRefs(snapshot)).toEqual([`crop-${"a".repeat(64)}`])
  })

  it("persists provider-independent worktree artifact changes and closes watchers", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-artifact-integration-"))
    scratchDirectories.push(scratch)
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.workspacePath = scratch
    delete session.providerThreadId
    delete session.activeTurnId
    snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.sessionId !== session.id)
    snapshot.annotations = snapshot.annotations.filter((annotation) => annotation.sessionId !== session.id)
    let watcherOptions: ArtifactWatcherOptions | undefined
    let releaseWatcherStart!: () => void
    const watcherStarting = new Promise<void>((resolve) => { releaseWatcherStart = resolve })
    const watcherStart = vi.fn(() => watcherStarting)
    const watcherStop = vi.fn()
    const store = {
      snapshot: structuredClone(snapshot),
      load() { return structuredClone(this.snapshot) },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: {},
      artifactWatcherFactory: (options) => {
        watcherOptions = options
        return { start: watcherStart, stop: watcherStop }
      },
    })
    running.push(daemon)

    const daemonStarting = daemon.start()
    const startWasNonblocking = await Promise.race([
      daemonStarting.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ])
    releaseWatcherStart()
    await daemonStarting
    expect(startWasNonblocking).toBe(true)
    expect(watcherStart).toHaveBeenCalledOnce()
    expect(watcherOptions?.root).toBe(scratch)

    await mkdir(join(scratch, "design-studio"), { recursive: true })
    await mkdir(join(scratch, "plans"), { recursive: true })
    await writeFile(join(scratch, "design-studio", "variant-a.html"), "<h1>Variant A</h1>")
    await writeFile(join(scratch, "plans", "review-plan.md"), "# Review plan")
    watcherOptions!.onChange({
      path: "design-studio/variant-a.html",
      title: "variant-a.html",
      type: "preview",
      mimeType: "text/html",
      variant: { id: "a", groupId: "design-studio", label: "Variant A", order: 0 },
    })
    watcherOptions!.onChange({
      path: "plans/review-plan.md",
      title: "review-plan.md",
      type: "plan",
      mimeType: "text/markdown",
      content: "# Review plan",
    })
    await vi.waitFor(() => expect(store.snapshot.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: session.id, path: "design-studio/variant-a.html", type: "preview", revision: 1, variant: { id: "a", groupId: "design-studio", label: "Variant A", order: 0 } }),
      expect.objectContaining({ sessionId: session.id, path: "plans/review-plan.md", type: "plan", content: "# Review plan", revision: 1 }),
    ])))

    watcherOptions!.onChange({
      path: "design-studio/variant-a.html",
      title: "variant-a.html",
      type: "preview",
      mimeType: "text/html",
      variant: { id: "a", groupId: "design-studio", label: "Variant A", order: 0 },
    })
    await vi.waitFor(() => expect(store.snapshot.artifacts.find(
      (artifact) => artifact.path === "design-studio/variant-a.html",
    )?.revision).toBe(2))
    await new Promise<void>((resolve) => setImmediate(resolve))

    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    expect(watcherStop).toHaveBeenCalledOnce()
  })

  it("keeps provider commands raw while redacting every durable and display copy", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-command-redaction-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "claude-code"
    session.workspacePath = "/worktrees/secret-redaction"
    session.providerThreadId = "thread-secret-redaction"
    session.activeTurnId = "turn-secret-redaction"
    snapshot.approvals = []
    snapshot.approvalRules = []
    snapshot.thread = snapshot.thread.filter((item) => item.sessionId !== session.id)
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-secret-redaction"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      evidence: vi.fn(async () => ({
        baseCommit: "a".repeat(40),
        diff: "",
        diffTruncated: false,
        totalChangedFiles: 0,
        files: [],
        filesTruncated: false,
      })),
    } satisfies WorkspaceService
    const seed = new SqliteWorkspaceStore(statePath, snapshot)
    seed.close()
    const legacy = structuredClone(snapshot)
    legacy.thread.push({
      id: "legacy-command-copy",
      sessionId: session.id,
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test --token legacy-display-secret",
      output: "password=legacy-output-secret",
      createdAt: "2026-08-29T12:00:00.000Z",
    })
    const injected = new DatabaseSync(statePath)
    injected.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1")
      .run(JSON.stringify(legacy))
    injected.close()
    const store = new SqliteWorkspaceStore(statePath, snapshot)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      workspaceService,
      agents: { "claude-code": agent },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const notifications: unknown[] = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: unknown }
      if (message.id === undefined) notifications.push(message)
    })
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: object) => new Promise<TestRpcResponse<M>>((resolve) => {
      const requestId = ++id
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message as TestRpcResponse<M>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })

    await rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue redaction test",
      client: "desktop",
    })

    const approvalEvent = {
      type: "approval-requested" as const,
      requestId: 91,
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      command: "OPENAI_API_KEY=sk-proj-command-secret pnpm test --token flag-command-secret",
      reason: "Authorization: Bearer approval-reason-secret",
      cwd: "https://dev:cwd-password@example.test/repo",
    }
    listener!(approvalEvent)
    const pending = await rpc("workspace.get", {})
    expect(JSON.stringify(pending.result)).not.toMatch(/legacy-display-secret|legacy-output-secret/)
    expect(approvalEvent.command).toContain("sk-proj-command-secret")
    expect(pending.result.approvals).toEqual([
      expect.objectContaining({
        providerRequestId: 91,
        risk: "hard-gate",
        command: "OPENAI_API_KEY=[REDACTED] pnpm test --token [REDACTED]",
        operation: "Authorization: [REDACTED]",
        directory: "https://[REDACTED]@example.test/repo",
      }),
    ])
    const approvalId = pending.result.approvals[0]!.id as string
    await expect(rpc("approval.resolve", {
      approvalId,
      decision: "always-project",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Hard-gate approvals cannot create standing rules" },
    })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
    expect((await rpc("workspace.get", {})).result.approvalRules).toEqual([])
    await rpc("approval.resolve", { approvalId, decision: "allow-once", client: "desktop" })
    expect(agent.resolveApproval).toHaveBeenCalledWith(91, "allow-once")

    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "command-redaction",
      delta: "token=",
    })
    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "command-redaction",
      delta: "stream-output-secret\r\n",
    })
    listener!({
      type: "item",
      phase: "completed",
      params: {
        threadId: session.providerThreadId,
        turnId: session.activeTurnId,
        item: {
          id: "command-redaction",
          type: "commandExecution",
          status: "completed",
          command: ["pnpm test --api-key", "tool-command-secret"],
          aggregatedOutput: "password=tool-output-secret\r\n42 tests passed",
        },
      },
    })
    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "command-no-aggregate",
      delta: "safe live line\n",
    })
    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "command-no-aggregate",
      delta: "token=",
    })
    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "command-no-aggregate",
      delta: "no-aggregate-stream-secret\r\n",
    })
    listener!({
      type: "item",
      phase: "completed",
      params: {
        threadId: session.providerThreadId,
        turnId: session.activeTurnId,
        item: {
          id: "command-no-aggregate",
          type: "commandExecution",
          status: "completed",
          command: ["pnpm test"],
        },
      },
    })
    const current = await rpc("workspace.get", {})
    const serialized = JSON.stringify(current.result)
    for (const secret of [
      "sk-proj-command-secret",
      "flag-command-secret",
      "approval-reason-secret",
      "cwd-password",
      "stream-output-secret",
      "tool-command-secret",
      "tool-output-secret",
      "no-aggregate-stream-secret",
      "legacy-display-secret",
      "legacy-output-secret",
    ]) {
      expect(serialized).not.toContain(secret)
      expect(JSON.stringify(notifications)).not.toContain(secret)
    }
    expect(current.result.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        title: "pnpm test --api-key [REDACTED]",
        output: "password=[REDACTED]\r\n42 tests passed",
      }),
      expect.objectContaining({
        kind: "tool",
        title: "pnpm test",
        output: "safe live line\ntoken=[REDACTED]\r\n",
      }),
    ]))
    expect(JSON.stringify(notifications)).toContain("safe live line\\n")
    expect(JSON.stringify(notifications)).toContain("token=[REDACTED]\\r\\n")

    const history = await rpc("session.history", {
      sessionId: session.id,
      categories: ["tools", "approvals", "tests"],
      limit: 50,
    })
    const evidence = await rpc("session.evidence", { sessionId: session.id })
    const exported = await rpc("audit.export", { limit: 500 })
    for (const response of [history.result, evidence.result, exported.result]) {
      expect(JSON.stringify(response)).not.toMatch(
        /sk-proj-command-secret|flag-command-secret|approval-reason-secret|cwd-password|stream-output-secret|tool-command-secret|tool-output-secret|no-aggregate-stream-secret|legacy-display-secret|legacy-output-secret/,
      )
    }

    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.close()
    await socketClosed
    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    const database = new DatabaseSync(statePath)
    const rawWorkspace = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get()
    const rawAudit = database.prepare("SELECT * FROM audit_log").all()
    database.close()
    expect(JSON.stringify({ rawWorkspace, rawAudit })).not.toMatch(
      /sk-proj-command-secret|flag-command-secret|approval-reason-secret|cwd-password|stream-output-secret|tool-command-secret|tool-output-secret|no-aggregate-stream-secret|legacy-display-secret|legacy-output-secret/,
    )
    const reopened = new SqliteWorkspaceStore(statePath, snapshot)
    expect(JSON.stringify(reopened.load())).not.toMatch(
      /sk-proj-command-secret|flag-command-secret|approval-reason-secret|cwd-password|stream-output-secret|tool-command-secret|tool-output-secret|no-aggregate-stream-secret|legacy-display-secret|legacy-output-secret/,
    )
    reopened.close()
  })

  it("reports usage persistence failures without dropping later provider events", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-usage-failure"
    session.activeTurnId = "turn-usage-failure"
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      snapshot: structuredClone(snapshot),
      load() { return structuredClone(this.snapshot) },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const errorSink = vi.fn()
    const daemon = new DomovoiDaemon({
      store,
      agents: { codex: agent },
      usageLedger: {
        record: vi.fn(() => { throw new Error("usage database unavailable") }),
        session: vi.fn(),
        close: vi.fn(),
      },
      errorSink,
    })
    running.push(daemon)

    listener!({
      type: "usage",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      usage: {
        inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0,
        totalTokens: 2, costSource: "unavailable",
      },
    })
    listener!({
      type: "text-delta",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      delta: "still delivered",
    })

    await vi.waitFor(() => expect(store.snapshot.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", body: "still delivered" }),
    ])))
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Domovoi could not persist provider usage",
      detail: expect.stringContaining("usage database unavailable"),
    }))
  })

  it("returns real Git and recorded test-run evidence without persisting it", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/session-evidence"
    snapshot.thread = snapshot.thread.filter((item) => item.sessionId !== session.id)
    snapshot.thread.push({
      id: "tool-test-evidence",
      sessionId: session.id,
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test",
      output: "42 tests passed",
      createdAt: "2026-08-29T12:00:00.000Z",
    })
    const save = vi.fn()
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      evidence: vi.fn(async () => ({
        baseCommit: "a".repeat(40),
        diff: "diff --git a/src/app.ts b/src/app.ts\n",
        diffTruncated: false,
        totalChangedFiles: 1,
        files: [{
          path: "src/app.ts",
          status: "modified" as const,
          staged: false,
          unstaged: true,
          additions: 3,
          deletions: 1,
          binary: false,
        }],
        filesTruncated: false,
      })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "evidence-token",
      store: { load: () => structuredClone(snapshot), save, close: vi.fn() },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id === 1) resolve(message)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.evidence",
      params: { sessionId: session.id },
    }))

    await expect(response).resolves.toMatchObject({
      id: 1,
      result: {
        sessionId: session.id,
        workspace: {
          baseCommit: "a".repeat(40),
          totalChangedFiles: 1,
          files: [expect.objectContaining({ path: "src/app.ts", additions: 3, deletions: 1 })],
        },
        tests: {
          passed: 1,
          failed: 0,
          totalRuns: 1,
          runs: [expect.objectContaining({
            id: "tool-test-evidence",
            command: "pnpm test",
            commandTruncated: false,
          })],
        },
      },
    })
    expect(workspaceService.evidence).toHaveBeenCalledWith(
      session.workspacePath,
      expect.any(AbortSignal),
    )
    expect(save).not.toHaveBeenCalled()
  })

  it("returns an explicit error when workspace evidence stays unstable", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/session-evidence"
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      evidence: vi.fn(async () => { throw new WorkspaceEvidenceUnstableError() }),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "unstable-evidence-token",
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id === 1) resolve(message)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.evidence",
      params: { sessionId: session.id },
    }))

    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { code: -32603, message: "Workspace changed while evidence was collected" },
    })
  })

  it.each([
    {
      name: "missing session",
      sessionId: "missing-session",
      workspacePath: "/worktrees/session-evidence",
      evidence: vi.fn(),
      message: "Session does not exist",
    },
    {
      name: "session without worktree",
      sessionId: demoWorkspace.sessions[0]!.id,
      workspacePath: undefined,
      evidence: vi.fn(),
      message: "Session has no worktree",
    },
    {
      name: "workspace service without evidence",
      sessionId: demoWorkspace.sessions[0]!.id,
      workspacePath: "/worktrees/session-evidence",
      evidence: undefined,
      message: "Session evidence is unavailable",
    },
  ])("rejects $name with stable invalid params", async ({
    sessionId,
    workspacePath,
    evidence,
    message,
  }) => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    if (workspacePath) session.workspacePath = workspacePath
    else delete session.workspacePath
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      ...(evidence ? { evidence } : {}),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "evidence-invalid-token",
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const next = JSON.parse(data.toString()) as Record<string, unknown>
        if (next.id === 1) resolve(next)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.evidence",
      params: { sessionId },
    }))

    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { code: -32602, message },
    })
    if (evidence) expect(evidence).not.toHaveBeenCalled()
  })

  it("serializes evidence refresh with the same session resource", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/session-evidence"
    let releaseEvidence: ((value: Awaited<ReturnType<NonNullable<WorkspaceService["evidence"]>>>) => void) | undefined
    const evidence = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<WorkspaceService["evidence"]>>>>(
      (resolve) => { releaseEvidence = resolve },
    ))
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      evidence,
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "evidence-queue-token",
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const responses: number[] = []
    const responseFor = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        responses.push(id)
        resolve(message)
      }
      socket.on("message", receive)
    })
    const refreshed = responseFor(1)
    const paused = responseFor(2)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.evidence",
      params: { sessionId: session.id },
    }))
    await vi.waitFor(() => expect(evidence).toHaveBeenCalledOnce())
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.pause",
      params: { sessionId: session.id, client: "desktop" },
    }))
    await Promise.resolve()
    expect(responses).toEqual([])

    releaseEvidence!({
      baseCommit: "a".repeat(40),
      diff: "",
      diffTruncated: false,
      totalChangedFiles: 0,
      files: [],
      filesTruncated: false,
    })

    await expect(refreshed).resolves.toMatchObject({ id: 1, result: { sessionId: session.id } })
    await expect(paused).resolves.toMatchObject({ id: 2, result: { activeSessionId: session.id } })
    expect(responses).toEqual([1, 2])
  })

  it("aborts timed-out evidence without accepting a late result", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/session-evidence"
    let observedSignal: AbortSignal | undefined
    let releaseEvidence: ((value: Awaited<ReturnType<NonNullable<WorkspaceService["evidence"]>>>) => void) | undefined
    const evidence = vi.fn((_path: string, signal?: AbortSignal) => {
      observedSignal = signal
      return new Promise<Awaited<ReturnType<NonNullable<WorkspaceService["evidence"]>>>>(
        (resolve) => { releaseEvidence = resolve },
      )
    })
    const save = vi.fn()
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      evidence,
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "evidence-timeout-token",
      agentTimeoutMs: 10,
      errorSink: vi.fn(),
      store: { load: () => structuredClone(snapshot), save, close: vi.fn() },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const messages: Array<Record<string, unknown>> = []
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id !== 1) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
    })
    const addedAbortListeners = vi.spyOn(AbortSignal.prototype, "addEventListener")
    const removedAbortListeners = vi.spyOn(AbortSignal.prototype, "removeEventListener")
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.evidence",
      params: { sessionId: session.id },
    }))

    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { code: -32603, message: "Session evidence timed out" },
    })
    expect(observedSignal?.aborted).toBe(true)
    const parentAbortListener = addedAbortListeners.mock.calls.find(
      ([type, _listener, options]) => type === "abort"
        && typeof options === "object"
        && options?.once === true,
    )?.[1]
    const parentAbortListenerRemoved = parentAbortListener !== undefined
      && removedAbortListeners.mock.calls.some(
        ([type, listener]) => type === "abort" && listener === parentAbortListener,
      )
    addedAbortListeners.mockRestore()
    removedAbortListeners.mockRestore()
    expect(parentAbortListener).toBeDefined()
    expect(parentAbortListenerRemoved).toBe(true)
    releaseEvidence!({
      baseCommit: "a".repeat(40),
      diff: "late",
      diffTruncated: false,
      totalChangedFiles: 0,
      files: [],
      filesTruncated: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.filter((message) => message.id === 1)).toHaveLength(1)
    expect(save).not.toHaveBeenCalled()
  })

  it("drains queued events once and rejects late shutdown events", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-shutdown"
    session.activeTurnId = "turn-shutdown"
    const activateTurns = deferLiveTurns(snapshot)
    const saves: typeof snapshot[] = []
    const order: string[] = []
    const store: WorkspaceStore = {
      load: () => snapshot,
      save: (next) => {
        order.push("save")
        saves.push(structuredClone(next))
      },
      close: () => { order.push("store:close") },
    }
    let listener: ((event: AgentEvent) => void) | undefined
    const unsubscribe = vi.fn()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return unsubscribe
      }),
      close: vi.fn(async () => { order.push("agent:close") }),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, authToken: "shutdown-token", store, agent })
    await daemon.start()
    activateTurns()

    listener!({
      type: "text-delta",
      threadId: "thread-shutdown",
      turnId: "turn-shutdown",
      delta: "queued before shutdown",
    })
    const firstStop = daemon.stop()
    listener!({
      type: "text-delta",
      threadId: "thread-shutdown",
      turnId: "turn-shutdown",
      delta: "late after shutdown",
    })
    await Promise.all([firstStop, daemon.stop()])

    const persisted = saves.at(-1)!
    expect(persisted.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", body: "queued before shutdown" }),
    ]))
    expect(persisted.thread).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.stringContaining("late after shutdown") }),
    ]))
    expect(saves).toHaveLength(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(agent.close).toHaveBeenCalledOnce()
    expect(order.at(-1)).toBe("store:close")
  })

  it("rejects RPC work after shutdown begins", async () => {
    let resolveInspection: ((providers: []) => void) | undefined
    const providerProbe = {
      inspect: vi.fn(() => new Promise<[]>((resolve) => { resolveInspection = resolve })),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "shutdown-token",
      statePath: ":memory:",
      providerProbe,
    })
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const stopping = daemon.stop()
    const messages: Array<Record<string, unknown>> = []
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    const responseFor = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
    })
    const response = responseFor(1)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace.get", params: {} }))

    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { code: -32002, message: "Daemon is shutting down" },
    })
    const barrier = responseFor(2)
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "workspace.get", params: {} }))
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace.get", params: {} }))
    await barrier
    expect(messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: null }),
    ]))
    resolveInspection!([])
    await stopping
  })

  it("restores the final queued event after a shutdown restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-shutdown-"))
    scratchDirectories.push(directory)
    const statePath = join(directory, "state.sqlite")
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/restart"
    session.providerThreadId = "thread-restart"
    delete session.activeTurnId
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-restart"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => {}
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "restart-token",
      statePath,
      store: new SqliteWorkspaceStore(statePath, snapshot),
      agent,
    })
    await daemon.start()

    const socket = authenticatedSocket(daemon, `ws://${daemon.address!.host}:${daemon.address!.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const sent = new Promise<void>((resolve) => {
      socket.on("message", function receive(data) {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== 1) return
        socket.off("message", receive)
        resolve()
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.send",
      params: { sessionId: session.id, prompt: "Persist this turn", client: "desktop" },
    }))
    await sent

    listener!({
      type: "text-delta",
      threadId: "thread-restart",
      turnId: "turn-restart",
      delta: "persist me before close",
    })
    socket.close()
    await daemon.stop()

    const recoveredStore = new SqliteWorkspaceStore(statePath, demoWorkspace)
    const recovered = recoveredStore.load()
    recoveredStore.close()
    expect(recovered.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", body: "persist me before close" }),
    ]))
  })

  it("reconciles persisted interrupted turns before listening", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-restart"
    session.providerThreadId = "thread-restart"
    session.activeTurnId = "turn-before-restart"
    snapshot.approvals = [{
      id: "approval-before-restart",
      sessionId: session.id,
      risk: "normal",
      operation: "Run tests",
      command: "pnpm test",
      machine: snapshot.machine.name,
      agent: "codex / gpt-5.6-sol",
      mode: session.runtime.permissionMode,
      directory: session.workspacePath,
      affects: "Session files",
      network: "None",
      estimatedDuration: "Unknown",
      checkpoint: session.baseCommit ?? "unavailable",
      providerRequestId: 91,
      requestedAt: new Date().toISOString(),
    }, {
      id: "approval-before-restart-2",
      sessionId: session.id,
      risk: "normal",
      operation: "Inspect status",
      command: "git status --short",
      machine: snapshot.machine.name,
      agent: "codex / gpt-5.6-sol",
      mode: session.runtime.permissionMode,
      directory: session.workspacePath,
      affects: "Session files",
      network: "None",
      estimatedDuration: "Unknown",
      checkpoint: session.baseCommit ?? "unavailable",
      providerRequestId: 92,
      requestedAt: new Date().toISOString(),
    }]
    const archived = snapshot.sessions[1]!
    archived.state = "archived"
    archived.archiveRequestedAt = "2026-08-30T12:00:00.000Z"
    archived.archiveCheckpoint = "a".repeat(40)
    archived.archivedAt = "2026-08-30T12:01:00.000Z"
    delete archived.workspacePath
    delete archived.providerThreadId
    delete archived.activeTurnId
    const archivedBefore = structuredClone(archived)

    const saves: typeof snapshot[] = []
    // The store closure below reads the daemon that is constructed after it.
    // eslint-disable-next-line prefer-const
    let daemon: DomovoiDaemon
    const store = {
      load: vi.fn(() => structuredClone(snapshot)),
      save: vi.fn((next: typeof snapshot) => {
        if (saves.length === 0) expect(daemon.address).toBeUndefined()
        saves.push(structuredClone(next))
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
      id: `audit-restart-${append.mock.calls.length}`,
      occurredAt: "2026-08-31T12:00:00.000Z",
      ...input,
    }))
    const auditLog = {
      append,
      query: vi.fn(() => ({ entries: [], hasMore: false })),
      export: vi.fn(() => ({
        format: "jsonl" as const,
        exportedAt: "2026-08-31T12:00:00.000Z",
        content: "",
        entryCount: 0,
        hasMore: false,
      })),
    } satisfies AuditLog
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-after-restart"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: [] })),
      restore: vi.fn(),
    } satisfies WorkspaceService
    daemon = new DomovoiDaemon({
      port: 0,
      store,
      auditLog,
      agent,
      workspaceService,
      artifactWatcherFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn() }),
    })
    running.push(daemon)
    const address = await daemon.start()

    expect(store.save).toHaveBeenCalledOnce()
    const recovered = saves[0]!
    expect(recovered.sessions.find(({ id }) => id === session.id)).toMatchObject({
      state: "idle",
      workspacePath: session.workspacePath,
      providerThreadId: session.providerThreadId,
    })
    expect(recovered.sessions.find(({ id }) => id === session.id)).not.toHaveProperty("activeTurnId")
    expect(recovered.sessions.find(({ id }) => id === archived.id)).toEqual(archivedBefore)
    expect(recovered.approvals).toEqual([])
    expect(recovered.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: session.id,
        kind: "system",
        body: "Daemon restart interrupted the active turn.",
        detail: expect.stringContaining("Pending approval requests were expired"),
      }),
    ]))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: "daemon", component: "startup-recovery" },
      action: "session.turn-interrupted",
      outcome: "cancelled",
      sessionId: session.id,
      target: "turn-before-restart",
    }))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: "daemon", component: "startup-recovery" },
      action: "approval.expired",
      outcome: "cancelled",
      sessionId: session.id,
      target: "approval-before-restart",
    }))
    expect(append.mock.calls
      .filter(([input]) => input.action === "approval.expired")
      .map(([input]) => input.target))
      .toEqual(["approval-before-restart", "approval-before-restart-2"])
    expect(agent.connect).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(agent.startTurn).not.toHaveBeenCalled()
    expect(agent.steerTurn).not.toHaveBeenCalled()
    expect(agent.interruptTurn).not.toHaveBeenCalled()

    const recoveredSystemItems = recovered.thread.filter(
      (item) => item.sessionId === session.id
        && item.kind === "system"
        && item.body === "Daemon restart interrupted the active turn.",
    )
    const secondSave = vi.fn()
    const secondAppend = vi.fn()
    const secondStore = {
      load: vi.fn(() => recovered),
      save: secondSave,
      close: vi.fn(),
    } satisfies WorkspaceStore
    const secondAuditLog = {
      append: secondAppend,
      query: vi.fn(() => ({ entries: [], hasMore: false })),
      export: vi.fn(() => ({
        format: "jsonl" as const,
        exportedAt: "2026-08-31T12:00:00.000Z",
        content: "",
        entryCount: 0,
        hasMore: false,
      })),
    } satisfies AuditLog
    const secondDaemon = new DomovoiDaemon({
      port: 0,
      store: secondStore,
      auditLog: secondAuditLog,
      agent,
      workspaceService,
      artifactWatcherFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn() }),
    })
    running.push(secondDaemon)
    await secondDaemon.start()
    expect(secondSave).not.toHaveBeenCalled()
    expect(secondAppend).not.toHaveBeenCalled()
    expect(recovered.thread.filter(
      (item) => item.sessionId === session.id
        && item.kind === "system"
        && item.body === "Daemon restart interrupted the active turn.",
    )).toHaveLength(recoveredSystemItems.length)

    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await expect(rpc("checkpoint.create", {
      sessionId: session.id,
      label: "after restart",
      client: "desktop",
    })).resolves.toMatchObject({ result: { sessions: expect.any(Array) } })
    await expect(rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue safely",
      client: "desktop",
    })).resolves.toMatchObject({
      result: { sessions: expect.arrayContaining([expect.objectContaining({
        id: session.id,
        activeTurnId: "turn-after-restart",
      })]) },
    })
    expect(agent.resumeThread).toHaveBeenCalledWith({
      threadId: "thread-restart",
      cwd: "/worktrees/session-restart",
      runtime: session.runtime,
    })
    expect(agent.startTurn).toHaveBeenCalledOnce()
    expect(agent.steerTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it("recovers sessions after a provider disconnect without steering a stale turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "thread-recover"
    session.activeTurnId = "turn-stale"
    snapshot.approvals = [{
      id: "approval-stale",
      sessionId: session.id,
      risk: "normal",
      operation: "Run tests",
      command: "pnpm test",
      machine: snapshot.machine.name,
      agent: "codex / gpt-5.6-sol",
      mode: session.runtime.permissionMode,
      directory: session.workspacePath ?? "/worktrees/session-billing",
      affects: "Session files",
      network: "None",
      estimatedDuration: "Unknown",
      checkpoint: session.baseCommit ?? "unavailable",
      providerRequestId: 91,
      requestedAt: new Date().toISOString(),
    }]
    const store = {
      load: vi.fn(() => structuredClone(snapshot)),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const listeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-recovered"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, store, agent })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await rpc("runtime.models", { provider: "codex", client: "desktop" })
    expect(agent.connect).toHaveBeenCalledOnce()
    expect(agent.listModels).toHaveBeenCalledOnce()
    for (const listener of listeners) {
      listener({
        type: "provider-disconnected",
        reason: "Codex app-server exited with code 1",
      })
      listener({
        type: "provider-disconnected",
        reason: "Codex app-server exited with code 1",
      })
    }

    const disconnected = await rpc("workspace.get", {})
    expect(disconnected).toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          state: "failed",
          providerThreadId: "thread-recover",
        })]),
        approvals: [],
        thread: expect.arrayContaining([expect.objectContaining({
          sessionId: session.id,
          kind: "system",
          body: "Codex disconnected. The next message will reconnect and resume this session.",
          detail: "Codex app-server exited with code 1",
        })]),
      },
    })
    const disconnectedSession = (disconnected.result as {
      sessions: Array<Record<string, unknown>>
      thread: Array<{ body?: string }>
    }).sessions.find((candidate) => candidate.id === session.id)!
    expect(disconnectedSession).not.toHaveProperty("activeTurnId")
    expect((disconnected.result as { thread: Array<{ body?: string }> }).thread.filter(
      (item) => item.body === "Codex disconnected. The next message will reconnect and resume this session.",
    )).toHaveLength(1)

    await rpc("runtime.models", { provider: "codex", client: "desktop" })
    expect(agent.connect).toHaveBeenCalledTimes(2)
    expect(agent.listModels).toHaveBeenCalledTimes(2)
    const resumed = await rpc("session.send", {
      sessionId: session.id,
      prompt: "Continue after recovery",
      client: "desktop",
    })

    expect(resumed).toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          state: "active",
          providerThreadId: "thread-recover",
          activeTurnId: "turn-recovered",
        })]),
      },
    })
    expect(agent.resumeThread).toHaveBeenCalledOnce()
    expect(agent.resumeThread).toHaveBeenCalledWith({
      threadId: "thread-recover",
      cwd: session.workspacePath,
      runtime: session.runtime,
    })
    expect(agent.startTurn).toHaveBeenCalledOnce()
    expect(agent.steerTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it("serializes provider disconnect recovery with an in-flight session send", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-race"
    session.providerThreadId = "thread-race"
    delete session.activeTurnId
    const listeners = new Set<(event: AgentEvent) => void>()
    let finishFirstTurn: ((turnId: string) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn()
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirstTurn = resolve }))
        .mockResolvedValue("turn-after-race"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await rpc("runtime.models", { provider: "codex", client: "desktop" })
    const interrupted = rpc("session.send", {
      sessionId: session.id,
      prompt: "Begin the work",
      client: "desktop",
    })
    await vi.waitFor(() => expect(agent.startTurn).toHaveBeenCalledOnce())
    for (const listener of listeners) {
      listener({ type: "provider-disconnected", reason: "transport lost during turn/start" })
    }
    finishFirstTurn!("turn-before-race")
    await expect(interrupted).resolves.toMatchObject({
      result: { sessions: expect.arrayContaining([expect.objectContaining({
        id: session.id,
        activeTurnId: "turn-before-race",
      })]) },
    })

    const failed = await rpc("workspace.get", {})
    expect(failed).toMatchObject({
      result: { sessions: expect.arrayContaining([expect.objectContaining({
        id: session.id,
        state: "failed",
        providerThreadId: "thread-race",
      })]) },
    })
    const failedSession = (failed.result as {
      sessions: Array<{ id: string; activeTurnId?: string }>
    }).sessions.find((candidate) => candidate.id === session.id)!
    expect(failedSession).not.toHaveProperty("activeTurnId")

    await rpc("session.send", {
      sessionId: session.id,
      prompt: "Retry after the transport loss",
      client: "desktop",
    })
    expect(agent.connect).toHaveBeenCalledTimes(2)
    expect(agent.resumeThread).toHaveBeenCalledTimes(2)
    expect(agent.startTurn).toHaveBeenCalledTimes(2)
    expect(agent.steerTurn).not.toHaveBeenCalled()
    expect(agent.startTurn.mock.calls.map(([input]) => input.prompt)).toEqual([
      expect.stringContaining("Begin the work"),
      expect.stringContaining("Retry after the transport loss"),
    ])
    expect(agent.startTurn.mock.calls[1]![0].prompt).not.toContain("Begin the work")
    socket.close()
  })

  it("rejects a stale connection completion and reconnects on the next request", async () => {
    let finishFirstConnection: (() => void) | undefined
    const listeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => {
          finishFirstConnection = resolve
        }))
        .mockResolvedValue(undefined),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", agent })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const models = rpc("runtime.models", { provider: "codex", client: "desktop" })
    await vi.waitFor(() => expect(agent.connect).toHaveBeenCalledOnce())
    for (const listener of listeners) {
      listener({ type: "provider-disconnected", reason: "lost during initialization" })
    }
    await rpc("workspace.get", {})
    finishFirstConnection!()

    await expect(models).resolves.toMatchObject({
      error: {
        code: -32603,
        message: "Internal daemon error",
      },
    })
    expect(agent.connect).toHaveBeenCalledOnce()
    expect(agent.listModels).not.toHaveBeenCalled()

    await expect(rpc("runtime.models", {
      provider: "codex",
      client: "desktop",
    })).resolves.toMatchObject({
      result: [expect.objectContaining({ provider: "codex", id: "gpt-5.6-sol" })],
    })
    expect(agent.connect).toHaveBeenCalledTimes(2)
    expect(agent.listModels).toHaveBeenCalledOnce()
    socket.close()
  })

  it("closes providers and storage when the final shutdown save fails", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-save-failure"
    session.activeTurnId = "turn-save-failure"
    const activateTurns = deferLiveTurns(snapshot)
    const store = {
      load: vi.fn(() => snapshot),
      save: vi.fn(() => { throw new Error("disk full") }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => {}
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, authToken: "failure-token", store, agent })
    await daemon.start()
    activateTurns()
    listener!({
      type: "text-delta",
      threadId: "thread-save-failure",
      turnId: "turn-save-failure",
      delta: "cannot persist",
    })

    await expect(daemon.stop()).rejects.toThrow("Domovoi shutdown failed")
    expect(agent.close).toHaveBeenCalledOnce()
    expect(store.close).toHaveBeenCalledOnce()
  })

  it("bounds client snapshots without deleting durable session history", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: maximumEffectiveClientThreadItems + 5 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))

    const clientSnapshot = workspaceSnapshotForClient(snapshot)

    expect(clientSnapshot.thread).toHaveLength(maximumEffectiveClientThreadItems)
    expect(clientSnapshot.thread[0]?.id).toBe("message-5")
    expect(snapshot.thread).toHaveLength(maximumEffectiveClientThreadItems + 5)
  })

  it("bounds client thread retention globally and prioritizes the active session", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions[0]!
    const inactive = snapshot.sessions[1]!
    snapshot.activeSessionId = active.id
    snapshot.thread = [active, inactive].flatMap((session) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: `${session.id}-message-${index}`,
        sessionId: session.id,
        kind: "user" as const,
        body: `Message ${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
      })),
    )

    const clientSnapshot = workspaceSnapshotForClient(snapshot)

    expect(clientSnapshot.thread).toHaveLength(100)
    expect(clientSnapshot.thread.every((item) => item.sessionId === active.id)).toBe(true)
    expect(snapshot.thread).toHaveLength(200)
  })

  it("marks client history truncation so fork ancestry remains parseable", () => {
    const snapshot = structuredClone(demoWorkspace)
    const source = snapshot.sessions[0]!
    const checkpoint = snapshot.thread.find((item) =>
      item.sessionId === source.id && item.kind === "checkpoint"
    )!
    if (checkpoint.kind !== "checkpoint" || !checkpoint.commit) throw new Error("checkpoint missing")
    snapshot.sessions.push({
      ...source,
      id: "session-fork-truncated",
      workspacePath: "/worktrees/session-fork-truncated",
      providerThreadId: "provider-thread-fork-truncated",
      forkedFrom: {
        sourceSessionId: source.id,
        checkpointId: checkpoint.id,
        checkpointCommit: checkpoint.commit,
        requestId: "fork-request-truncated",
        client: "desktop",
        requestedRuntime: source.runtime,
      },
    })
    snapshot.thread.push(...Array.from({ length: 100 }, (_, index) => ({
      id: `newer-message-${index}`,
      sessionId: source.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 29, 0, 0, index)).toISOString(),
    })))

    const clientSnapshot = workspaceSnapshotForClient(snapshot)

    expect(clientSnapshot.historyTruncated).toBe(true)
    expect(clientSnapshot.thread.some((item) => item.id === checkpoint.id)).toBe(false)
    expect(workspaceSnapshotSchema.safeParse(clientSnapshot).success).toBe(true)
    expect(workspaceSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it("pages backward through complete session history", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: 205 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))
    snapshot.annotations = []

    const newest = sessionHistoryPage(snapshot, { sessionId: session.id, limit: 100 })
    const middle = sessionHistoryPage(snapshot, {
      sessionId: session.id,
      before: newest?.nextCursor,
      limit: 100,
    })
    const oldest = sessionHistoryPage(snapshot, {
      sessionId: session.id,
      before: middle?.nextCursor,
      limit: 100,
    })

    expect(newest?.items.map((item) => item.id)).toEqual([
      "thread:message-105",
      ...Array.from({ length: 99 }, (_, index) => `thread:message-${index + 106}`),
    ])
    expect(middle?.items[0]?.id).toBe("thread:message-5")
    expect(oldest).toMatchObject({
      items: Array.from({ length: 5 }, (_, index) => expect.objectContaining({
        id: `thread:message-${index}`,
      })),
      hasMore: false,
    })
    expect(sessionHistoryPage(snapshot, {
      sessionId: session.id,
      before: "missing",
      limit: 50,
    })).toBeUndefined()
  })

  it("builds typed history from durable thread and annotation records", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const createdAt = "2026-08-28T12:00:00.000Z"
    snapshot.thread = [
      {
        id: "message-one",
        sessionId: session.id,
        kind: "user",
        body: "Check the replay worker",
        createdAt,
      },
      {
        id: "tool-tests",
        sessionId: session.id,
        kind: "tool",
        tool: "command",
        status: "failed",
        title: "pnpm --filter @getdomovoi/ui test",
        output: "1 failed",
        createdAt,
      },
      {
        id: "tool-status",
        sessionId: session.id,
        kind: "tool",
        tool: "command",
        status: "completed",
        title: "git status --short",
        createdAt,
      },
      {
        id: "handoff-one",
        sessionId: session.id,
        kind: "system",
        body: "Handed off codex / old to claude-code / new.",
        detail: "Checkpointed first.",
        createdAt,
      },
      {
        id: "checkpoint-one",
        sessionId: session.id,
        kind: "checkpoint",
        label: "before handoff",
        commit: "a".repeat(40),
        createdAt,
      },
      {
        id: "approval-one",
        sessionId: session.id,
        kind: "receipt",
        decision: "allow-once",
        operation: "Run tests",
        checkpoint: "checkpoint-one",
        client: "desktop",
        createdAt,
      },
    ]
    snapshot.annotations = [{
      id: "annotation-one",
      sessionId: session.id,
      artifactId: "artifact-plan",
      anchor: { textQuote: "Replay worker" },
      body: "Make this clearer",
      status: "open",
      origin: "desktop",
      thread: [{
        id: "reply-one",
        body: "Updated in the next pass",
        origin: "web",
        createdAt,
      }],
      createdAt,
      updatedAt: createdAt,
    }]

    const entries = sessionHistoryEntries(snapshot, session.id)

    expect(entries.map(({ id, category }) => [id, category])).toEqual([
      ["annotation-reply:annotation-one:reply-one", "annotations"],
      ["annotation:annotation-one", "annotations"],
      ["thread:approval-one", "approvals"],
      ["thread:checkpoint-one", "checkpoints"],
      ["thread:handoff-one", "handoffs"],
      ["thread:message-one", "messages"],
      ["thread:tool-status", "tools"],
      ["thread:tool-tests", "tests"],
    ])
    expect(entries.find((entry) => entry.id === "annotation:annotation-one")).toMatchObject({
      action: "created",
      annotationId: "annotation-one",
      status: "open",
    })
  })

  it.each([
    "pnpm --filter @getdomovoi/ui test",
    "npm run test:unit",
    "bun test src/replay.test.ts",
    "npx vitest run",
    "pytest -q",
    "go test ./...",
    "cargo test --workspace",
    "./gradlew test",
  ])("classifies an observed test command: %s", (title) => {
    expect(isTestCommandTitle(title)).toBe(true)
  })

  it.each([
    "echo test",
    "cat test-results.txt",
    "npm run contest",
    "npm testicular",
    "git status --short",
    "Command output",
  ])("does not infer tests from an unrelated command: %s", (title) => {
    expect(isTestCommandTitle(title)).toBe(false)
  })

  it("filters before paging with stable cursors at equal timestamps", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const createdAt = "2026-08-28T12:00:00.000Z"
    snapshot.thread = ["alpha", "beta", "gamma"].map((name) => ({
      id: `message-${name}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `${name} replay`,
      createdAt,
    }))
    snapshot.thread.push({
      id: "tool-test",
      sessionId: session.id,
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test",
      output: "replay passed",
      createdAt,
    })

    const newest = sessionHistoryPage(snapshot, {
      sessionId: session.id,
      categories: ["messages"],
      query: "REPLAY",
      limit: 2,
    })
    const oldest = sessionHistoryPage(snapshot, {
      sessionId: session.id,
      categories: ["messages"],
      query: "replay",
      before: newest?.nextCursor,
      limit: 2,
    })

    expect(newest).toMatchObject({
      items: [
        expect.objectContaining({ id: "thread:message-beta" }),
        expect.objectContaining({ id: "thread:message-gamma" }),
      ],
      hasMore: true,
      nextCursor: "thread:message-beta",
    })
    expect(oldest).toMatchObject({
      items: [expect.objectContaining({ id: "thread:message-alpha" })],
      hasMore: false,
    })
    expect(sessionHistoryPage(snapshot, {
      sessionId: session.id,
      categories: ["messages"],
      before: "thread:tool-test",
      limit: 2,
    })).toBeUndefined()
  })

  it("indexes large mixed history once and bounds repeated filtered pages", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const other = snapshot.sessions[1]!
    snapshot.thread = Array.from({ length: 12_000 }, (_, index) => {
      const base = {
        id: `message-${index}`,
        sessionId: index % 3 === 0 ? other.id : session.id,
        createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
      }
      return index % 5 === 0
        ? { ...base, kind: "tool" as const, tool: "command" as const, status: "completed" as const, title: `pnpm test shard ${index}`, output: index % 10 === 0 ? "needle passed" : "passed" }
        : { ...base, kind: "user" as const, body: index % 11 === 0 ? `needle message ${index}` : `message ${index}` }
    })
    snapshot.annotations = Array.from({ length: 600 }, (_, index) => ({
      id: `annotation-${index}`,
      sessionId: index % 2 === 0 ? session.id : other.id,
      artifactId: "artifact-plan",
      anchor: { textQuote: `line ${index}` },
      body: index % 7 === 0 ? `needle annotation ${index}` : `annotation ${index}`,
      status: "open" as const,
      origin: "desktop" as const,
      thread: [],
      createdAt: new Date(Date.UTC(2026, 7, 29, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 29, 0, 0, index)).toISOString(),
    }))
    const metrics = {
      indexBuilds: 0,
      indexedEntries: 0,
      filterScans: 0,
      filteredEntriesVisited: 0,
      pageLookups: 0,
      cachedFilterEntries: 0,
      filterEvictions: 0,
    }
    const index = new SessionHistoryIndex(metrics)
    const first = index.page(snapshot, {
      sessionId: session.id,
      categories: ["messages", "tests", "annotations"],
      query: "NEEDLE",
      limit: 50,
    })!
    const afterFirst = { ...metrics }
    const second = index.page(snapshot, {
      sessionId: session.id,
      categories: ["messages", "tests", "annotations"],
      query: "needle",
      before: first.nextCursor,
      limit: 50,
    })!

    expect(first.items).toHaveLength(50)
    expect(second.items).toHaveLength(50)
    expect(metrics.indexBuilds).toBe(1)
    expect(metrics.filterScans).toBe(1)
    expect(metrics.indexedEntries).toBeLessThanOrEqual(12_600)
    expect(metrics.filteredEntriesVisited).toBe(afterFirst.filteredEntriesVisited)
    expect(metrics.pageLookups - afterFirst.pageLookups).toBe(1)
  })

  it("normalizes the full category set without duplicating the base index", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: 2_000 }, (_, index) => ({
      id: `all-category-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))
    snapshot.annotations = []
    const metrics = {
      indexBuilds: 0,
      indexedEntries: 0,
      filterScans: 0,
      filteredEntriesVisited: 0,
      pageLookups: 0,
      cachedFilterEntries: 0,
      filterEvictions: 0,
    }
    const index = new SessionHistoryIndex(metrics)

    const page = index.page(snapshot, {
      sessionId: session.id,
      categories: ["messages", "tools", "approvals", "handoffs", "checkpoints", "annotations", "tests"],
      limit: 50,
    })!
    index.page(snapshot, {
      sessionId: session.id,
      categories: ["messages", "tools", "approvals", "handoffs", "checkpoints", "annotations", "tests"],
      before: page.nextCursor,
      limit: 50,
    })

    expect(metrics.filterScans).toBe(0)
    expect(metrics.cachedFilterEntries).toBe(0)
    expect(metrics.pageLookups).toBe(2)
  })

  it("bounds total cached filter entries while retaining the active filter", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: 8_000 }, (_, index) => ({
      id: `cache-message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `shared-a shared-b shared-c message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))
    snapshot.annotations = []
    const metrics = {
      indexBuilds: 0,
      indexedEntries: 0,
      filterScans: 0,
      filteredEntriesVisited: 0,
      pageLookups: 0,
      cachedFilterEntries: 0,
      filterEvictions: 0,
    }
    const index = new SessionHistoryIndex(metrics)
    let active
    for (const query of ["shared-a", "shared-b", "shared-c"]) {
      active = index.page(snapshot, { sessionId: session.id, query, limit: 50 })!
    }
    const afterActive = { ...metrics }
    index.page(snapshot, {
      sessionId: session.id,
      query: "shared-c",
      before: active!.nextCursor,
      limit: 50,
    })

    expect(metrics.cachedFilterEntries).toBeLessThanOrEqual(
      Math.max(maximumCachedSessionHistoryFilterEntries, snapshot.thread.length),
    )
    expect(metrics.filterEvictions).toBeGreaterThanOrEqual(2)
    expect(metrics.filterScans).toBe(afterActive.filterScans)
    expect(metrics.filteredEntriesVisited).toBe(afterActive.filteredEntriesVisited)
  })

  it("keeps cached cursor semantics and invalidates message and annotation edits", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const message = snapshot.thread.find((item) => item.sessionId === session.id && item.kind === "user")!
    const annotation = snapshot.annotations.find((item) => item.sessionId === session.id)!
    const index = new SessionHistoryIndex()

    const page = index.page(snapshot, { sessionId: session.id, query: "not-yet-present", limit: 50 })
    expect(page?.items).toEqual([])
    if (message.kind !== "user") throw new Error("message fixture changed")
    message.body = "not-yet-present in edited message"
    annotation.body = "not-yet-present in edited annotation"
    annotation.status = "resolved"
    annotation.thread.push({
      id: "edited-reply",
      body: "not-yet-present in reply",
      origin: "web",
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    index.invalidate(session.id)

    expect(index.page(snapshot, {
      sessionId: session.id,
      categories: ["messages"],
      query: "not-yet-present",
      limit: 50,
    })?.items.map((item) => item.id)).toEqual([`thread:${message.id}`])
    expect(index.page(snapshot, {
      sessionId: session.id,
      categories: ["annotations"],
      query: "resolved",
      limit: 50,
    })?.items).toEqual([expect.objectContaining({ id: `annotation:${annotation.id}`, status: "resolved" })])
    expect(index.page(snapshot, {
      sessionId: session.id,
      categories: ["annotations"],
      query: "in reply",
      limit: 50,
    })?.items).toEqual([expect.objectContaining({ id: `annotation-reply:${annotation.id}:edited-reply` })])
  })

  it("rejects an aborted history scan before stale work can complete", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: 1_000 }, (_, index) => ({
      id: `abort-message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))
    const index = new SessionHistoryIndex()

    expect(() => index.page(snapshot, { sessionId: session.id, query: "missing", limit: 50 }, AbortSignal.abort()))
      .toThrowError(expect.objectContaining({ name: "AbortError" }))
  })

  it("invalidates cached history after persisted annotation RPC mutations", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const annotation = snapshot.annotations.find((item) =>
      item.sessionId === "session-billing" && item.status === "open"
    )!
    snapshot.annotations.forEach((item) => { item.status = "open" })
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    const daemon = new DomovoiDaemon({ port: 0, store })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    const history = (query: string) => rpc("session.history", {
      sessionId: annotation.sessionId,
      categories: ["annotations"],
      query,
      limit: 50,
    })

    await expect(history("rpc cache invalidation reply")).resolves.toMatchObject({
      result: { items: [] },
    })
    await expect(rpc("annotation.reply", {
      annotationId: annotation.id,
      body: "RPC cache invalidation reply",
      client: "desktop",
    })).resolves.toHaveProperty("result")
    await expect(history("rpc cache invalidation reply")).resolves.toMatchObject({
      result: {
        items: [expect.objectContaining({
          id: expect.stringContaining("annotation-reply:"),
          body: "RPC cache invalidation reply",
        })],
      },
    })

    await expect(history("resolved")).resolves.toMatchObject({ result: { items: [] } })
    await expect(rpc("annotation.setStatus", {
      annotationId: annotation.id,
      status: "resolved",
      client: "desktop",
    })).resolves.toHaveProperty("result")
    await expect(history("resolved")).resolves.toMatchObject({
      result: {
        items: [expect.objectContaining({ id: `annotation:${annotation.id}`, status: "resolved" })],
      },
    })
    expect(store.load().annotations.find((item) => item.id === annotation.id)).toMatchObject({
      status: "resolved",
      thread: expect.arrayContaining([
        expect.objectContaining({ body: "RPC cache invalidation reply" }),
      ]),
    })
    socket.close()
  })

  it("serves bounded snapshots with older history available by cursor", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.thread = Array.from({ length: 105 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))
    snapshot.annotations = []
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "history-token",
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const hello = await rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      authToken: "history-token",
    })
    expect((hello.result as { thread: unknown[] }).thread).toHaveLength(100)

    const newest = await rpc("session.history", { sessionId: session.id, limit: 100 })
    expect(newest.result).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "thread:message-5" })]),
      hasMore: true,
      nextCursor: "thread:message-5",
    })
    const oldest = await rpc("session.history", {
      sessionId: session.id,
      before: "thread:message-5",
      limit: 100,
    })
    expect((oldest.result as { items: unknown[] }).items).toHaveLength(5)
    expect(oldest.result).toMatchObject({ hasMore: false })
    const filtered = await rpc("session.history", {
      sessionId: session.id,
      categories: ["messages"],
      query: "MESSAGE 104",
      limit: 100,
    })
    expect(filtered.result).toMatchObject({
      items: [expect.objectContaining({ id: "thread:message-104", category: "messages" })],
      hasMore: false,
    })
    await expect(rpc("session.history", {
      sessionId: session.id,
      before: "missing",
      limit: 50,
    })).resolves.toMatchObject({ error: { code: -32602 } })
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve())
      socket.close()
    })
  })

  it("bounds streamed workspace delta chunks without losing content", () => {
    const input = "x".repeat((maximumWorkspaceDeltaChunkLength * 2) + 1)

    const chunks = workspaceDeltaChunks(input)

    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.length <= maximumWorkspaceDeltaChunkLength)).toBe(true)
    expect(chunks.join("")).toBe(input)
  })

  it("migrates turn-scoped plan artifacts into one session plan", () => {
    const artifacts = [
      {
        id: "plan-session-a-turn-1",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan" as const,
        revision: 1,
        mimeType: "text/markdown",
        content: "1. Inspect.\n",
      },
      {
        id: "preview-a",
        sessionId: "session-a",
        title: "Preview",
        type: "preview" as const,
        revision: 1,
      },
      {
        id: "plan-session-a-turn-2",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan" as const,
        revision: 2,
        mimeType: "text/markdown",
        content: "2. Implement.\n",
      },
    ]

    const annotations = [{
      id: "annotation-a",
      sessionId: "session-a",
      artifactId: "plan-session-a-turn-2",
      anchor: { textQuote: "Implement" },
      body: "Keep this step.",
      status: "open" as const,
      origin: "desktop" as const,
      thread: [],
      createdAt: "2026-08-26T20:00:00.000Z",
      updatedAt: "2026-08-26T20:00:00.000Z",
    }]

    expect(appendPlanDelta(artifacts, annotations, "session-a", "3. Verify.")).toMatchObject({
      id: "plan-session-a",
      revision: 4,
      content: "1. Inspect.\n2. Implement.\n3. Verify.",
    })
    expect(artifacts.filter((artifact) => artifact.type === "plan")).toHaveLength(1)
    expect(artifacts.find((artifact) => artifact.id === "preview-a")).toBeDefined()
    expect(annotations[0]!.artifactId).toBe("plan-session-a")
  })

  it("requires signed access for preview documents outside loopback", () => {
    expect(canServeArtifacts("127.0.0.1")).toBe(true)
    expect(canServeArtifacts("::1")).toBe(true)
    expect(canServeArtifacts("100.64.0.10")).toBe(false)
    expect(canServeArtifacts("100.64.0.10", true)).toBe(true)
    expect(canServeArtifacts("0.0.0.0")).toBe(false)
  })

  it("scopes artifact access to id, bridge channel, and expiry", () => {
    const scope = { sessionId: "session-1", artifactId: "preview-1", revision: 2, purpose: "preview" as const, bridgeChannel: "preview_channel_123456", expiresAt: 1_800_000_000 }
    const signature = signArtifactAccess("artifact-secret", scope)
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(artifactAccessMatches(
      "artifact-secret",
      scope,
      signature,
      1_799_999_999,
    )).toBe(true)
    expect(artifactAccessMatches(
      "artifact-secret",
      { ...scope, purpose: "print" },
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      { ...scope, bridgeChannel: "preview_channel_changed" },
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      scope,
      signature,
      1_800_000_001,
    )).toBe(false)
  })

  it("limits preview embedding to configured browser origins", () => {
    expect(frameAncestorsFor([
      "https://app.domovoi.sh",
      "http://localhost:5178",
      "file://",
      "javascript:alert(1)",
      "not a URL",
    ])).toBe("https://app.domovoi.sh http://localhost:5178 file:")
  })

  it("normalizes loopback Host authorities without widening them", () => {
    expect(hostAuthorityMatches("[::1]:47831", "::1", 47831)).toBe(true)
    expect(hostAuthorityMatches("localhost:47831", "::1", 47831)).toBe(true)
    expect(hostAuthorityMatches("127.0.0.1:47831", "127.0.0.1", 47831)).toBe(true)
    expect(hostAuthorityMatches("localhost:47832", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("attacker.example:47831", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1", "127.0.0.1", 80)).toBe(true)
    expect(hostAuthorityMatches("localhost", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("user@127.0.0.1:47831", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831/path", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831?query", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831#fragment", "127.0.0.1", 47831)).toBe(false)
  })

  it("requires protected transport for non-loopback listeners", () => {
    expect(() => new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      statePath: ":memory:",
    })).toThrow("Non-loopback listeners require explicit protected-transport opt-in")
    const daemon = new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      statePath: ":memory:",
      allowRemoteTransport: true,
    })
    expect(daemon.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("serves remote previews only with a signed capability", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-remote-artifact-"))
    scratchDirectories.push(scratch)
    await writeFile(join(scratch, "preview.html"), "<h1>Remote preview</h1>")
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.workspacePath = scratch
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === "artifact-preview")!
    artifact.path = "preview.html"
    artifact.mimeType = "text/html"
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      allowRemoteTransport: true,
      authToken: "remote-daemon-token",
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await rpc("system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "remote-daemon-token",
    })
    const accessResponse = await rpc("artifact.authorize", {
      sessionId: artifact.sessionId,
      artifactId: artifact.id,
      revision: artifact.revision,
      purpose: "preview",
      client: "web",
    })
    const access = accessResponse.result as { sessionId: string; revision: number; purpose: string; expiresAt: number; signature: string }
    const baseUrl = `http://${address.host}:${address.port}/artifacts/${artifact.id}`

    expect((await fetch(baseUrl)).status).toBe(404)
    const authorized = await fetch(
      `${baseUrl}?session=${access.sessionId}&revision=${access.revision}&purpose=${access.purpose}&expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(authorized.status).toBe(200)
    await expect(authorized.text()).resolves.toBe("<h1>Remote preview</h1>")
    expect((await fetch(
      `${baseUrl}?session=${access.sessionId}&revision=${access.revision}&purpose=${access.purpose}&expires=${access.expiresAt}&signature=${"x".repeat(43)}`,
    )).status).toBe(404)
    socket.close()
  })

  it.each(["toString", "constructor"])(
    "rejects inherited RPC method name %s as method not found",
    async (method) => {
      const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
      running.push(daemon)
      const address = await daemon.start()
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      const response = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => {
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        })
      })

      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }))

      await expect(response).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: `Unknown method: ${method}` },
      })
      socket.close()
    },
  )

  it("reports the persisted machine identity to clients", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      machineIdentity: { id: `machine-${"7".repeat(32)}`, label: "workshop" },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "web", clientVersion: "0.0.1" },
    }))

    await expect(response).resolves.toMatchObject({
      result: { machine: { id: `machine-${"7".repeat(32)}`, name: "workshop" } },
    })
    socket.close()
  })

  it("reports a protocol-valid machine identity without a persisted one", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "web", clientVersion: "0.0.1" },
    }))

    const hello = await response
    const machine = (hello.result as { machine: { id: string } }).machine
    expect(machineIdSchema.safeParse(machine.id).success).toBe(true)
    socket.close()
  })

  it("accepts a paired device credential and rejects it once revoked", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const paired = store.devices.pair({ label: "studio-ipad" })

    const open = (token: string) => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
        headers: { authorization: `Bearer ${token}` },
      })
      return socket
    }
    const hello = (socket: WebSocket) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => {
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        })
      })
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "system.hello",
        params: { client: "tablet", clientVersion: "0.0.1" },
      }))
      return response
    }

    const pairedSocket = open(paired.token)
    await new Promise<void>((resolve, reject) => {
      pairedSocket.once("open", resolve)
      pairedSocket.once("error", reject)
    })
    await expect(hello(pairedSocket)).resolves.toMatchObject({
      result: { machine: { id: expect.any(String) } },
    })
    pairedSocket.close()

    store.devices.revoke(paired.device.id)
    const revokedSocket = open(paired.token)
    await new Promise<void>((resolve, reject) => {
      revokedSocket.once("open", resolve)
      revokedSocket.once("error", reject)
    })
    await expect(hello(revokedSocket)).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    revokedSocket.close()
  })

  it.each([
    ["revoked", (store: SqliteWorkspaceStore, deviceId: string) => {
      store.devices.revoke(deviceId)
    }],
    ["rotated", (store: SqliteWorkspaceStore, deviceId: string) => {
      store.devices.rotate(deviceId)
    }],
  ])("drops a live connection whose device credential is %s", async (_case, invalidate) => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const paired = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const send = (id: number, method: string, params: Record<string, unknown>) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => {
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        })
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await expect(send(1, "system.hello", { client: "tablet", clientVersion: "0.0.1" }))
      .resolves.toMatchObject({ result: { machine: { id: expect.any(String) } } })

    invalidate(store, paired.device.id)

    await expect(send(2, "workspace.get", {})).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    await expect(send(3, "workspace.get", {})).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    socket.close()
  })

  it("lists this daemon in the fleet registry", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      machineIdentity: { id: `machine-${"7".repeat(32)}`, label: "workshop" },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "fleet.list", params: {} }))

    await expect(response).resolves.toMatchObject({
      result: {
        machines: [{
          id: `machine-${"7".repeat(32)}`,
          label: "workshop",
          connection: "local",
          self: true,
          heartbeat: { state: "online" },
          capabilities: expect.arrayContaining(["sessions", "terminals"]),
        }],
      },
    })
    socket.close()
  })

  async function pairingClient(daemon: DomovoiDaemon, token?: string) {
    const address = daemon.address!
    const socket = token === undefined
      ? authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      : new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
        headers: { authorization: `Bearer ${token}` },
      })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const call = (id: number, method: string, params: Record<string, unknown>) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await call(1, "system.hello", { client: "desktop", clientVersion: "0.0.1" })
    return { socket, call }
  }

  it("pairs a device and returns its credential exactly once", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await pairingClient(daemon)

    const paired = await call(2, "device.pair", { label: "studio-ipad", client: "desktop" })
    const listed = await call(3, "device.list", {})

    const token = (paired.result as { token: string }).token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(listed).toMatchObject({
      result: { devices: [{ label: "studio-ipad", id: expect.stringMatching(/^device-/) }] },
    })
    expect(JSON.stringify(listed)).not.toContain(token)
    socket.close()
  })

  it("keeps a paired credential out of the audit log", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await pairingClient(daemon)

    const paired = await call(2, "device.pair", { label: "studio-ipad", client: "desktop" })

    const token = (paired.result as { token: string }).token
    const entries = store.auditLog.query({ limit: 50 }).entries
    expect(JSON.stringify(entries)).not.toContain(token)
    expect(entries.some((entry) => entry.action === "device.pair")).toBe(true)
    socket.close()
  })

  it("revokes and rotates a paired device", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await pairingClient(daemon)
    const paired = await call(2, "device.pair", { label: "studio-ipad", client: "desktop" })
    const deviceId = (paired.result as { device: { id: string } }).device.id

    const rotated = await call(3, "device.rotate", { deviceId, client: "desktop" })
    const revoked = await call(4, "device.revoke", { deviceId, client: "desktop" })

    const rotatedToken = (rotated.result as { token: string }).token
    expect(rotatedToken).not.toBe((paired.result as { token: string }).token)
    expect(revoked).toMatchObject({ result: { device: { revokedAt: expect.any(String) } } })
    expect(store.devices.verify(rotatedToken)).toBeUndefined()
    socket.close()
  })

  it("refuses to manage devices for a client holding only a device credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const { socket, call } = await pairingClient(daemon, issued.token)

    const pairAttempt = await call(2, "device.pair", { label: "second-ipad", client: "tablet" })
    const revokeAttempt = await call(3, "device.revoke", {
      deviceId: issued.device.id,
      client: "tablet",
    })

    for (const attempt of [pairAttempt, revokeAttempt]) {
      expect(attempt).toMatchObject({
        error: { message: "Managing paired devices requires the daemon credential" },
      })
    }
    expect(store.devices.list()).toHaveLength(1)
    socket.close()
  })

  it("stops broadcasting to a device the moment it is revoked", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket, "web")
    const notifications: string[] = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method?: string }
      if (message.method) notifications.push(message.method)
    })

    const admin = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      admin.once("open", resolve)
      admin.once("error", reject)
    })
    await identifyClient(admin)
    const revoked = new Promise<void>((resolve) => {
      admin.once("message", () => resolve())
    })
    const deviceClosed = new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) resolve()
      else socket.once("close", () => resolve())
    })
    admin.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "device.revoke",
      params: { deviceId: issued.device.id, client: "desktop" },
    }))
    await revoked
    await deviceClosed
    notifications.length = 0
    const activated = new Promise<void>((resolve) => {
      admin.once("message", () => resolve())
    })
    admin.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.activate",
      params: { sessionId: demoWorkspace.sessions[1]!.id, client: "desktop" },
    }))
    await activated
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(notifications).toEqual([])
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    admin.close()
    socket.close()
  })

  it("serves an encrypted listener when given TLS material", async () => {
    const { execFileSync } = await import("node:child_process")
    let openssl = true
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" })
    } catch {
      openssl = false
    }
    if (!openssl) return

    const scratch = await mkdtemp(join(tmpdir(), "domovoi-tls-server-"))
    scratchDirectories.push(scratch)
    const certPath = join(scratch, "cert.pem")
    const keyPath = join(scratch, "key.pem")
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=localhost",
    ], { stdio: "ignore" })
    const { loadTlsMaterial } = await import("./tls-material.js")
    const tls = await loadTlsMaterial({ certPath, keyPath })

    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      tls,
    })
    running.push(daemon)
    const address = await daemon.start()

    const socket = new WebSocket(`wss://127.0.0.1:${address.port}/rpc`, {
      rejectUnauthorized: false,
      headers: { authorization: "Bearer correct-horse-battery-staple" },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "desktop", clientVersion: "0.0.1" },
    }))

    await expect(response).resolves.toMatchObject({
      result: { machine: { id: expect.any(String) } },
    })
    socket.close()
  })

  async function unauthenticatedSocket(daemon: DomovoiDaemon) {
    const address = daemon.address!
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const call = (id: number, method: string, params: Record<string, unknown>) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    return { socket, call }
  }

  it("keeps a credential for a machine it was given", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const credentials = new Map<string, string>()
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: (machineId: string, credential: string) => credentials.set(machineId, credential),
        forMachine: (machineId: string) => credentials.get(machineId),
        forget: (machineId: string) => credentials.delete(machineId),
        machines: () => [...credentials.keys()],
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "device.saveCredential",
      params: { machineId: `machine-${"b".repeat(32)}`, credential: "n".repeat(43) },
    }))

    await expect(response).resolves.toMatchObject({ result: { saved: true } })
    expect(credentials.get(`machine-${"b".repeat(32)}`)).toBe("n".repeat(43))
    expect(JSON.stringify(store.auditLog.query({ limit: 20 }).entries)).not.toContain("n".repeat(43))
    socket.close()
  })

  it("refuses to keep a credential for a client holding only a device credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const credentials = new Map<string, string>()
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: (machineId: string, credential: string) => credentials.set(machineId, credential),
        forMachine: (machineId: string) => credentials.get(machineId),
        forget: (machineId: string) => credentials.delete(machineId),
        machines: () => [...credentials.keys()],
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "device.saveCredential",
      params: { machineId: `machine-${"b".repeat(32)}`, credential: "n".repeat(43) },
    }))

    await expect(response).resolves.toMatchObject({
      error: { message: "Managing paired devices requires the daemon credential" },
    })
    expect(credentials.size).toBe(0)
    socket.close()
  })

  it("returns a kept machine credential to a daemon client", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const credentials = new Map<string, string>([[`machine-${"b".repeat(32)}`, "n".repeat(43)]])
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: (machineId: string, credential: string) => credentials.set(machineId, credential),
        forMachine: (machineId: string) => credentials.get(machineId),
        forget: (machineId: string) => credentials.delete(machineId),
        machines: () => [...credentials.keys()],
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "device.machineCredential",
      params: { machineId: `machine-${"b".repeat(32)}` },
    }))

    await expect(response).resolves.toMatchObject({ result: { credential: "n".repeat(43) } })
    expect(JSON.stringify(store.auditLog.query({ limit: 20 }).entries)).not.toContain("n".repeat(43))
    socket.close()
  })

  it("refuses a machine credential to a client holding only a device credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const credentials = new Map<string, string>([[`machine-${"b".repeat(32)}`, "n".repeat(43)]])
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: (machineId: string, credential: string) => credentials.set(machineId, credential),
        forMachine: (machineId: string) => credentials.get(machineId),
        forget: (machineId: string) => credentials.delete(machineId),
        machines: () => [...credentials.keys()],
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "device.machineCredential",
      params: { machineId: `machine-${"b".repeat(32)}` },
    }))

    const refusal = await response
    expect(refusal).toMatchObject({
      error: { message: "Managing paired devices requires the daemon credential" },
    })
    expect(JSON.stringify(refusal)).not.toContain("n".repeat(43))
    socket.close()
  })

  it("refuses a machine credential it never kept", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: () => {},
        forMachine: () => undefined,
        forget: () => {},
        machines: () => [],
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "device.machineCredential",
      params: { machineId: `machine-${"d".repeat(32)}` },
    }))

    await expect(response).resolves.toMatchObject({
      error: { message: "No credential is kept for that machine" },
    })
    socket.close()
  })

  it("issues a pairing code to an authenticated client", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "device.issueCode", params: {} }))

    await expect(response).resolves.toMatchObject({
      result: {
        code: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/),
        expiresAt: expect.any(String),
      },
    })
    socket.close()
  })

  it("refuses to issue a pairing code to a client holding only a device credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "device.issueCode", params: {} }))

    await expect(response).resolves.toMatchObject({
      error: { message: "Managing paired devices requires the daemon credential" },
    })
    socket.close()
  })

  it("refuses to issue a pairing code to an unauthenticated socket", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await unauthenticatedSocket(daemon)

    await expect(call(1, "device.issueCode", {})).resolves.toMatchObject({
      error: { message: "Daemon authentication required" },
    })
    socket.close()
  })

  it("pairs an unauthenticated machine that presents the pairing code", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const issued = daemon.issuePairingCode()
    const { socket, call } = await unauthenticatedSocket(daemon)

    const claimed = await call(1, "device.claim", { code: issued.code, label: "studio-ipad" })

    const token = (claimed.result as { token: string }).token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.devices.verify(token)?.label).toBe("studio-ipad")
    socket.close()
  })

  it("lets an unauthenticated socket do nothing but claim", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    daemon.issuePairingCode()
    const { socket, call } = await unauthenticatedSocket(daemon)

    for (const method of ["workspace.get", "device.list", "fleet.list"]) {
      await expect(call(1, method, {})).resolves.toMatchObject({
        error: { message: "Daemon authentication required" },
      })
    }
    socket.close()
  })

  it("refuses a claim when no pairing is open", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await unauthenticatedSocket(daemon)

    await expect(call(1, "device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad" }))
      .resolves.toMatchObject({ error: { message: "Pairing was refused" } })
    expect(store.devices.list()).toHaveLength(0)
    socket.close()
  })

  it("refuses every rejected claim with the same words", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const { socket, call } = await unauthenticatedSocket(daemon)

    const withNoPairingOpen = await call(1, "device.claim", {
      code: "hearth-quiet-ember-42",
      label: "studio-ipad",
    })
    daemon.issuePairingCode()
    const withWrongCode = await call(2, "device.claim", {
      code: "willow-harbor-cedar-11",
      label: "studio-ipad",
    })

    const refusal = (response: Record<string, unknown>) =>
      (response.error as { message: string }).message
    expect(refusal(withNoPairingOpen)).toBe("Pairing was refused")
    expect(refusal(withWrongCode)).toBe(refusal(withNoPairingOpen))
    socket.close()
  })

  it("audits a pairing without recording the code or the credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    await daemon.start()
    const issued = daemon.issuePairingCode()
    const { socket, call } = await unauthenticatedSocket(daemon)

    const claimed = await call(1, "device.claim", { code: issued.code, label: "studio-ipad" })

    const token = (claimed.result as { token: string }).token
    const entries = store.auditLog.query({ limit: 50 }).entries
    expect(entries.some((entry) => entry.action === "device.claim")).toBe(true)
    expect(JSON.stringify(entries)).not.toContain(token)
    expect(JSON.stringify(entries)).not.toContain(issued.code)
    socket.close()
  })

  it("requires the configured token before serving daemon state", async () => {
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
      authToken: "correct-horse-battery-staple",
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const unauthenticated = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const unauthenticatedMessages: Array<Record<string, unknown>> = []
    unauthenticated.on("message", (data) => {
      unauthenticatedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once("open", resolve)
      unauthenticated.once("error", reject)
    })
    const rpc = (id: number, method: string, params: Record<string, unknown>) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await expect(rpc(1, "workspace.get", {})).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication required" },
    })
    await expect(rpc(2, "system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "wrong-token",
    })).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    await expect(rpc(3, "system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "correct-horse-battery-staple",
    })).resolves.toMatchObject({ result: { machine: { id: expect.any(String) } } })
    await expect(rpc(4, "workspace.get", {})).resolves.toMatchObject({
      result: { project: { id: "project-acme-api" } },
    })
    await expect(rpc(5, "session.activate", {
      sessionId: "session-audit",
      client: "web",
    })).resolves.toMatchObject({ result: { activeSessionId: "session-audit" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(unauthenticatedMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "workspace.changed" }),
    ]))

    const pipelined = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      pipelined.once("open", resolve)
      pipelined.once("error", reject)
    })
    const pipelinedResponses = new Map<number, Record<string, unknown>>()
    const receivedBoth = new Promise<void>((resolve) => {
      pipelined.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id === 6 || message.id === 7) pipelinedResponses.set(message.id, message)
        if (pipelinedResponses.size === 2) resolve()
      })
    })
    pipelined.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "system.hello",
      params: {
        client: "web",
        clientVersion: "0.0.1",
        authToken: "correct-horse-battery-staple",
      },
    }))
    pipelined.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "runtime.models",
      params: { provider: "codex", client: "web" },
    }))
    await receivedBoth
    expect(pipelinedResponses.get(6)).toHaveProperty("result")
    expect(pipelinedResponses.get(7)).toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    pipelined.close()

    const attacker = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      attacker.once("open", resolve)
      attacker.once("error", reject)
    })
    const rejected = new Promise<{ code: number; reason: string }>((resolve) => {
      attacker.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    for (const id of [8, 9, 10]) {
      attacker.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "system.hello",
        params: { client: "web", clientVersion: "0.0.1", authToken: "wrong-token" },
      }))
    }
    await expect(rejected).resolves.toEqual({ code: 1008, reason: "authentication failed" })
    unauthenticated.close()
    socket.close()
  })

  it("enforces schema-sized authenticated and pre-auth payload limits", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const schemaSizedResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })
    const schemaSizedRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "annotation.create",
      params: {
        sessionId: "session-billing",
        artifactId: "missing-artifact",
        anchor: { textQuote: "schema-sized upload" },
        body: "Keep the upload capability.",
        visualContextUpload: {
          artifactRevision: 1,
          mimeType: "image/png",
          width: 1,
          height: 1,
          data: "A".repeat(2_000_000),
        },
        client: "desktop",
      },
    })
    expect(Buffer.byteLength(schemaSizedRequest)).toBeLessThan(maximumWebSocketPayloadBytes)
    socket.send(schemaSizedRequest)
    await expect(schemaSizedResponse).resolves.toMatchObject({
      id: 1,
      error: { code: -32602, message: "Artifact does not belong to the session" },
    })

    const oversized = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    const outcome = new Promise<{ type: "close"; code: number } | { type: "message" }>((resolve, reject) => {
      oversized.once("error", reject)
      oversized.once("close", (code) => resolve({ type: "close", code }))
      oversized.once("message", () => resolve({ type: "message" }))
    })
    await new Promise<void>((resolve, reject) => {
      oversized.once("open", resolve)
      oversized.once("error", reject)
    })
    oversized.send("x".repeat(maximumWebSocketPayloadBytes + 1))

    const oversizedOutcome = await outcome

    const unauthenticated = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const unauthenticatedOutcome = new Promise<
      { type: "close"; code: number } | { type: "message" }
    >((resolve, reject) => {
      unauthenticated.once("error", reject)
      unauthenticated.once("close", (code) => resolve({ type: "close", code }))
      unauthenticated.once("message", () => resolve({ type: "message" }))
    })
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once("open", resolve)
      unauthenticated.once("error", reject)
    })
    const oversizedAuthenticationRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "system.hello",
      params: {
        client: "web",
        clientVersion: "x".repeat(maximumAuthenticationPayloadBytes),
        authToken: daemon.authToken,
      },
    })
    expect(Buffer.byteLength(oversizedAuthenticationRequest)).toBeGreaterThan(
      maximumAuthenticationPayloadBytes,
    )
    unauthenticated.send(oversizedAuthenticationRequest)

    expect([oversizedOutcome, await unauthenticatedOutcome]).toEqual([
      { type: "close", code: 1009 },
      { type: "close", code: 1009 },
    ])
    socket.close()
  })

  it("authenticates bounded frames before mutation queue admission", async () => {
    let releaseInspection!: (repository: {
      root: string
      name: string
      branch: string
      head: string
    }) => void
    const inspection = new Promise<{
      root: string
      name: string
      branch: string
      head: string
    }>((resolve) => { releaseInspection = resolve })
    const workspaceService = {
      inspect: vi.fn(() => inspection),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "queue-auth-token",
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const authenticated = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      authenticated.once("open", resolve)
      authenticated.once("error", reject)
    })
    authenticated.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "project.open",
      params: { path: "/blocked", client: "desktop" },
    }))
    await vi.waitFor(() => expect(workspaceService.inspect).toHaveBeenCalledOnce())

    const unauthenticated = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once("open", resolve)
      unauthenticated.once("error", reject)
    })
    const rejection = new Promise<Record<string, unknown>>((resolve) => {
      unauthenticated.once("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      })
    })
    unauthenticated.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "workspace.get",
      params: {},
    }))

    await expect(rejection).resolves.toMatchObject({
      id: 2,
      error: { code: -32001, message: "Daemon authentication required" },
    })
    releaseInspection({ root: "/blocked", name: "blocked", branch: "main", head: "a".repeat(40) })
    unauthenticated.close()
    authenticated.close()
  })

  it("generates authentication for loopback daemons", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    expect(daemon.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const address = await daemon.start()

    const request = async (authToken?: string) => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once("error", reject)
        socket.once("open", () => socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "system.hello",
          params: {
            client: "desktop",
            clientVersion: "0.0.1",
            ...(authToken ? { authToken } : {}),
          },
        })))
        socket.once("message", (data) => resolve(JSON.parse(data.toString())))
      })
      socket.close()
      return response
    }

    await expect(request()).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    await expect(request(daemon.authToken)).resolves.toMatchObject({
      result: { machine: { id: expect.any(String) } },
    })
    const headerSocket = authenticatedSocket(
      daemon,
      `ws://${address.host}:${address.port}/rpc`,
    )
    const headerResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
      headerSocket.once("error", reject)
      headerSocket.once("open", () => headerSocket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "workspace.get",
        params: {},
      })))
      headerSocket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    expect(headerResponse).toMatchObject({ result: { machine: { id: expect.any(String) } } })
    headerSocket.close()
  })

  it("closes sockets that never authenticate", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      authTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    await expect(closed).resolves.toEqual({ code: 1008, reason: "authentication timeout" })
  })

  it("interrupts scoped and global turns and records who paused them", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions[0]!.state = "active"
    snapshot.sessions[0]!.runtime.provider = "codex"
    snapshot.sessions[0]!.providerThreadId = "thread-billing"
    snapshot.sessions[0]!.activeTurnId = "turn-billing"
    snapshot.sessions[1]!.providerThreadId = "thread-onboarding"
    snapshot.sessions[1]!.activeTurnId = "turn-onboarding"
    snapshot.sessions[2]!.state = "active"
    snapshot.sessions[2]!.runtime.provider = "codex"
    snapshot.sessions[2]!.providerThreadId = "thread-audit"
    snapshot.sessions[2]!.activeTurnId = "turn-audit"
    const activateTurns = deferLiveTurns(snapshot)
    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async (threadId: string) => {
        if (threadId === "thread-audit") await new Promise<void>(() => {})
      }),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
      agent,
      agentTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.pause",
      params: { sessionId: "session-billing", client: "phone" },
    }))

    await expect(response).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", state: "idle" }),
          expect.objectContaining({ id: "session-onboarding", state: "active" }),
        ]),
        approvals: [],
        thread: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-billing",
            kind: "system",
            body: "Paused by phone.",
          }),
        ]),
      },
    })
    expect(agent.interruptTurn).toHaveBeenCalledOnce()
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-billing", "turn-billing")

    const globalResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "system.pauseAll",
      params: { client: "tablet" },
    }))
    await expect(globalResponse).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-onboarding", state: "idle" }),
          expect.objectContaining({
            id: "session-audit",
            state: "failed",
          }),
        ]),
        thread: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-onboarding",
            kind: "system",
            body: "Paused by tablet.",
          }),
          expect.objectContaining({
            sessionId: "session-audit",
            kind: "system",
            body: "Provider thread quarantined after Agent interrupt timed out.",
          }),
        ]),
      },
    })
    expect(agent.interruptTurn).toHaveBeenCalledTimes(3)
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-onboarding", "turn-onboarding")
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-audit", "turn-audit")
    expect(agent.stopThread).toHaveBeenCalledWith("thread-audit")
    const globalSnapshot = (await globalResponse).result as {
      sessions: Array<{ id: string; providerThreadId?: string }>
    }
    const auditSession = globalSnapshot.sessions.find((session) => session.id === "session-audit")
    expect(auditSession).toBeDefined()
    expect(auditSession).not.toHaveProperty("providerThreadId")

    for (const listener of agentListeners) {
      listener({
        type: "approval-requested",
        requestId: 99,
        threadId: "thread-billing",
        turnId: "turn-billing",
        command: "pnpm deploy",
      })
    }
    const afterLateApproval = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 3) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "workspace.get", params: {} }))
    await expect(afterLateApproval).resolves.toMatchObject({ result: { approvals: [] } })
    socket.close()
  })

  it("stops a quarantined provider thread when persistence fails", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-persistence"
    session.activeTurnId = "turn-persistence"
    const activateTurns = deferLiveTurns(snapshot)
    const store = {
      load: vi.fn(() => snapshot),
      save: vi.fn(() => { throw new Error("State persistence failed") }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(() => new Promise<void>(() => {})),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, store, agent, agentTimeoutMs: 10 })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.pause",
      params: { sessionId: session.id, client: "desktop" },
    }))

    await expect(response).resolves.toMatchObject({
      error: { code: -32603, message: "Internal daemon error" },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("thread-persistence")
    socket.close()
  })

  it("orders one session without blocking an unrelated session", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const first = snapshot.sessions[0]!
    const second = snapshot.sessions[1]!
    for (const [session, threadId] of [
      [first, "thread-first"],
      [second, "thread-second"],
    ] as const) {
      session.state = "idle"
      session.runtime.provider = "codex"
      session.workspacePath = `/worktrees/${session.id}`
      session.providerThreadId = threadId
      delete session.activeTurnId
    }
    let releaseFirstTurn: ((turnId: string) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(({ threadId }: { threadId: string }) => threadId === "thread-first"
        ? new Promise<string>((resolve) => { releaseFirstTurn = resolve })
        : Promise.resolve("turn-second")),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const firstTurn = rpc("session.send", {
      sessionId: first.id,
      prompt: "Block this session",
      client: "desktop",
    })
    await vi.waitFor(() => expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-first",
    })))
    const queuedSameSession = rpc("session.send", {
      sessionId: first.id,
      prompt: "Run second in this session",
      client: "desktop",
    })
    const unrelated = rpc("session.send", {
      sessionId: second.id,
      prompt: "Run independently",
      client: "desktop",
    })
    const usage = rpc("session.usage", { sessionId: first.id })
    const responsiveness = await Promise.race([
      unrelated.then(() => "responsive" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    const usageResponsiveness = await Promise.race([
      usage.then(() => "responsive" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    expect(agent.steerTurn).not.toHaveBeenCalled()
    releaseFirstTurn!("turn-first")
    await Promise.all([firstTurn, queuedSameSession, unrelated, usage])

    expect(responsiveness).toBe("responsive")
    expect(usageResponsiveness).toBe("responsive")
    expect(agent.steerTurn).toHaveBeenCalledWith(
      "thread-first",
      "turn-first",
      expect.stringContaining("Run second in this session"),
    )
    socket.close()
  })

  it("serves an empty initial workspace over JSON-RPC", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "system.hello",
            params: { client: "desktop", clientVersion: "0.0.1" },
          }),
        )
      })
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        project: null,
        sessions: [],
        activeSessionId: null,
      },
    })

    const rejectedSession = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.create",
      params: {
        title: "Should not start",
        runtime: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoning: "medium",
          permissionMode: "ask",
          auto: false,
        },
        client: "desktop",
      },
    }))
    await expect(rejectedSession).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Open a valid Git repository with project.open before creating a session",
      },
    })
    socket.close()
  })

  it("creates a separate usage database after preparing a new state directory", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-usage-init-"))
    scratchDirectories.push(scratch)
    const stateDirectory = join(scratch, "new-state")
    const daemon = new DomovoiDaemon({ port: 0, statePath: join(stateDirectory, "state.sqlite") })
    running.push(daemon)

    await access(join(stateDirectory, "state.sqlite"))
    await access(join(stateDirectory, "usage.sqlite"))
    if (process.platform !== "win32") {
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(stateDirectory, "usage.sqlite"))).mode & 0o777).toBe(0o600)
    }
  })

  it("returns stable internal errors and logs only redacted diagnostics", async () => {
    const errorEntries: Array<{ context: string; detail: string }> = []
    const workspaceService = {
      inspect: vi.fn(async () => {
        throw new Error(
          "Provider unavailable; Authorization: Bearer rpc-secret-token; password=worktree-secret",
        )
      }),
      createSessionWorkspace: vi.fn(async () => {
        throw new Error("unused")
      }),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => {
        throw new Error("unused")
      }),
      restore: vi.fn(async () => {
        throw new Error("unused")
      }),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      workspaceService,
      errorSink: (entry) => errorEntries.push(entry),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "project.open",
      params: { path: "/code/private", client: "desktop" },
    }))

    await expect(response).resolves.toMatchObject({
      id: 41,
      error: { code: -32603, message: "Internal daemon error" },
    })
    expect(errorEntries).toHaveLength(1)
    expect(errorEntries[0]).toMatchObject({
      context: "RPC project.open failed",
      detail: expect.stringContaining("Provider unavailable"),
    })
    expect(errorEntries[0]!.detail).toContain("[REDACTED]")
    expect(errorEntries[0]!.detail).not.toContain("rpc-secret-token")
    expect(errorEntries[0]!.detail).not.toContain("worktree-secret")
    socket.close()
  })

  it("lists daemon-discovered skills with their provenance", async () => {
    const skillCatalog = {
      list: vi.fn(async () => [{
        id: "skill-4d6f4d6f4d6f",
        name: "repo-audit",
        description: "Audit a repository and render a ranked report.",
        path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
        scope: "user" as const,
        source: "agents" as const,
        ...skillSecurityMetadata,
      }]),
      read: vi.fn(async (id: string) => ({
        skill: {
          id,
          name: "repo-audit",
          description: "Audit a repository and render a ranked report.",
          path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
          scope: "user" as const,
          source: "agents" as const,
          ...skillSecurityMetadata,
        },
        content: "---\nname: repo-audit\n---\n",
      })),
    } satisfies SkillCatalog
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "skill.list",
        params: {},
      })))
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })

    expect(response).toMatchObject({
      result: [expect.objectContaining({
        name: "repo-audit",
        scope: "user",
        source: "agents",
      })],
    })
    expect(skillCatalog.list).toHaveBeenCalledOnce()
    const documentResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "skill.read",
      params: { id: "skill-4d6f4d6f4d6f" },
    }))
    await expect(documentResponse).resolves.toMatchObject({
      result: {
        skill: { name: "repo-audit" },
        content: expect.stringContaining("name: repo-audit"),
      },
    })
    expect(skillCatalog.read).toHaveBeenCalledWith("skill-4d6f4d6f4d6f")

    const inventoryResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "skill.inventory",
      params: {},
    }))
    const inventory = await inventoryResponse
    expect(inventory).toMatchObject({
      result: {
        machine: {
          id: expect.stringMatching(/^machine-/),
          name: expect.any(String),
          platform: expect.any(String),
          arch: expect.any(String),
          version: "0.0.1",
        },
        skills: [{
          id: "skill-4d6f4d6f4d6f",
          name: "repo-audit",
          signature: { state: "unsigned" },
          trust: { state: "untrusted", reason: "unsigned" },
        }],
      },
    })
    expect(JSON.stringify(inventory)).not.toMatch(/SKILL\.md|\/home\/|"content":|signatureValue|installCommand|archive|executable|symlinkTarget/)
    socket.close()
  })

  it("persists exact project skill reviews and audits the client", async () => {
    const auditLog = { append: vi.fn(), query: vi.fn(), export: vi.fn() }
    let currentSkill: SkillSummary = {
      id: "skill-4d6f4d6f4d6f",
      name: "repo-audit",
      description: "Audit a repository.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
      scope: "user" as const,
      source: "agents" as const,
      ...skillSecurityMetadata,
    }
    const skillCatalog = {
      list: vi.fn(async () => [currentSkill]),
      read: vi.fn(async (id: string) => {
        if (id !== currentSkill.id) throw new SkillNotFoundError()
        return { skill: currentSkill, content: "review me" }
      }),
    } satisfies SkillCatalog
    const daemon = new DomovoiDaemon({
      port: 0,
      store: {
        load: () => structuredClone(demoWorkspace),
        save: vi.fn(),
        close: vi.fn(),
      },
      auditLog,
      skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const notifications: Array<Record<string, unknown>> = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.method === "workspace.changed") notifications.push(message)
    })
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message)
        }
        socket.on("message", receive)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
    await new Promise<void>((resolve) => socket.once("open", () => resolve()))
    await rpc(1, "system.hello", {
      authToken: daemon.authToken,
      client: "desktop",
      clientId: "desktop-reviewer",
      clientVersion: "0.0.1",
    })
    const review = {
      id: currentSkill.id,
      enabled: true,
      contentDigest: currentSkill.contentDigest,
      manifest: currentSkill.manifest,
    }

    const enabled = await rpc(2, "skill.setEnabled", review)
    expect(enabled).toMatchObject({ result: { skillEnablements: [{
      projectId: demoWorkspace.project!.id,
      skillId: currentSkill.id,
      enabled: true,
      reviewedBy: { client: "desktop", clientId: "desktop-reviewer" },
    }] } })
    currentSkill = { ...currentSkill, contentDigest: `sha256:${"b".repeat(64)}` }
    await expect(rpc(3, "skill.setEnabled", review)).resolves.toMatchObject({
      error: { code: -32602, message: "Skill content changed; review it again" },
    })
    const rereviewed = await rpc(4, "skill.setEnabled", {
      ...review,
      contentDigest: currentSkill.contentDigest,
    })
    expect(rereviewed).toMatchObject({ result: { skillEnablements: [{
      contentDigest: currentSkill.contentDigest,
      enabled: true,
    }] } })
    await expect(rpc(5, "skill.setEnabled", {
      ...review,
      contentDigest: currentSkill.contentDigest,
      manifest: { version: 1, capabilities: ["process.execute"] },
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Skill capabilities changed; review them again" },
    })
    currentSkill = {
      ...currentSkill,
      trust: { state: "blocked", reason: "invalid-signature" },
    }
    await expect(rpc(6, "skill.setEnabled", {
      ...review,
      contentDigest: currentSkill.contentDigest,
    })).resolves.toMatchObject({ error: { code: -32602, message: "Blocked skills cannot be enabled" } })
    await expect(rpc(7, "skill.setEnabled", {
      ...review,
      id: "skill-000000000000",
      contentDigest: currentSkill.contentDigest,
    })).resolves.toMatchObject({ error: { code: -32602, message: "Skill not found" } })
    currentSkill = {
      ...currentSkill,
      trust: { state: "untrusted", reason: "unsigned" },
    }
    const disabled = await rpc(8, "skill.setEnabled", {
      ...review,
      contentDigest: currentSkill.contentDigest,
      enabled: false,
    })
    expect(disabled).toMatchObject({ result: { skillEnablements: [{ enabled: false }] } })
    await vi.waitFor(() => expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "workspace.changed",
        params: expect.objectContaining({
          skillEnablements: [expect.objectContaining({
            skillId: currentSkill.id,
            enabled: false,
          })],
        }),
      }),
    ])))
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: "client", client: "desktop", clientId: "desktop-reviewer" },
      action: "skill.setEnabled",
      projectId: demoWorkspace.project!.id,
      target: currentSkill.id,
      detail: expect.stringMatching(/^enabled=(true|false) digest=sha256:/),
    }))
    socket.close()
  })

  it("rejects skill review without an open project", async () => {
    const skill = {
      id: "skill-4d6f4d6f4d6f",
      name: "repo-audit",
      description: "Audit a repository.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
      scope: "user" as const,
      source: "agents" as const,
      ...skillSecurityMetadata,
    }
    const skillCatalog = {
      list: vi.fn(async () => [skill]),
      read: vi.fn(async (id: string) => {
        if (id === "skill-000000000000") throw new Error("Skill not found")
        return { skill, content: "review me" }
      }),
    } satisfies SkillCatalog
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", skillCatalog })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    const rpc = (id: number, skillId = skill.id) => new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "skill.setEnabled",
        params: {
          id: skillId,
          enabled: true,
          contentDigest: skill.contentDigest,
          manifest: skill.manifest,
        },
      }))
    })
    await new Promise<void>((resolve) => socket.once("open", () => resolve()))
    await expect(rpc(1)).resolves.toMatchObject({ error: { code: -32602, message: "Open a project before reviewing skills" } })
    socket.close()
  })

  it("publishes provider readiness discovered on the execution machine", async () => {
    const providerProbe = {
      inspect: vi.fn(async () => [
        { id: "claude-code", command: "claude", status: "ready" as const, version: "2.1.247" },
        { id: "cursor-agent", command: "agent", status: "ready" as const, version: "2026.08.1" },
        { id: "grok", command: "grok", status: "auth-required" as const, version: "0.18.0" },
        { id: "opencode", command: "opencode", status: "missing" as const },
      ]),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      providerProbe,
    })
    running.push(daemon)
    const address = await daemon.start()
    await vi.waitFor(() => expect(providerProbe.inspect).toHaveBeenCalledOnce())
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.get",
        params: {},
      })))
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })

    expect(response).toMatchObject({
      result: {
        machine: {
          providers: [
            { id: "claude-code", command: "claude", status: "ready", version: "2.1.247", sessionCapable: true },
            { id: "cursor-agent", command: "agent", status: "ready", version: "2026.08.1", sessionCapable: true },
            { id: "grok", command: "grok", status: "auth-required", version: "0.18.0", sessionCapable: true },
            { id: "opencode", command: "opencode", status: "missing", sessionCapable: true },
          ],
        },
      },
    })
    socket.close()
  })

  it("re-probes provider readiness on authenticated refresh without accepting credentials", async () => {
    const providerProbe = {
      inspect: vi.fn()
        .mockResolvedValueOnce([
          { id: "codex", command: "codex", status: "unknown" as const },
        ])
        .mockResolvedValueOnce([
          { id: "codex", command: "codex", status: "ready" as const, version: "0.149.0" },
        ]),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      providerProbe,
    })
    running.push(daemon)
    const address = await daemon.start()
    await vi.waitFor(() => expect(providerProbe.inspect).toHaveBeenCalledOnce())
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "provider.refresh",
        params: { client: "desktop" },
      })))
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })

    expect(providerProbe.inspect).toHaveBeenCalledTimes(2)
    expect(response).toMatchObject({
      result: {
        machine: {
          providers: [{
            id: "codex",
            status: "ready",
            version: "0.149.0",
            sessionCapable: true,
          }],
        },
      },
    })
    expect(JSON.stringify(response)).not.toMatch(/credential|password|secret|token/i)
    socket.close()
  })

  it("reports provider keychain status without mutation RPC", async () => {
    const providerSecrets = {
      status: vi.fn((): ProviderSecretStatus[] => [
        { provider: "openai" as const, state: "not-set" as const, source: "keychain" as const },
      ]),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "provider-secret-token",
      providerSecrets,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
      const listener = (data: import("ws").RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", listener)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", listener)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })

    const list = await request(101, "provider.secret.list", {})
    expect(list).toMatchObject({ result: [{ provider: "openai", state: "not-set", source: "keychain" }] })
    expect(JSON.stringify(list)).not.toContain("secret-value")

    socket.close()
  })

  it("records a project-scoped rule for standing approval", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals[0]!.risk = "normal"
    snapshot.approvals[0]!.operation = "Run the test suite"
    snapshot.approvals[0]!.command = "pnpm test"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)

    const approvalResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: {
        approvalId: "approval-migrate",
        decision: "always-project",
        client: "desktop",
      },
    }))

    await expect(approvalResponse).resolves.toMatchObject({
      result: {
        approvals: [],
        approvalRules: [
          expect.objectContaining({
            projectId: "project-acme-api",
            operation: "Run the test suite",
            command: "pnpm test",
            createdBy: "desktop",
          }),
        ],
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "receipt",
            decision: "always-project",
            checkpoint: "ckpt_7f21",
            client: "desktop",
          }),
        ]),
      },
    })
    socket.close()
  })

  it("issues immutable connection IDs for approval attribution", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals[0]!.risk = "normal"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
    })
    running.push(daemon)
    const address = await daemon.start()
    const connect = async () => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
        const listener = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", listener)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", listener)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
      const hello = await request(1, "system.hello", {
        client: "web",
        clientId: "spoofed-device-id",
        clientVersion: "0.0.1",
        authToken: daemon.authToken,
      })
      return { socket, request, hello }
    }
    const first = await connect()
    const second = await connect()
    const firstConnectionId = (first.hello.result as { connectionId?: string }).connectionId
    const secondConnectionId = (second.hello.result as { connectionId?: string }).connectionId

    expect(firstConnectionId).toEqual(expect.any(String))
    expect(secondConnectionId).toEqual(expect.any(String))
    expect(firstConnectionId).not.toBe(secondConnectionId)
    await expect(first.request(2, "system.hello", {
      client: "desktop",
      clientId: "changed-device-id",
      clientVersion: "0.0.1",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Connection client identity is already established" },
    })

    const resolved = await first.request(3, "approval.resolve", {
      approvalId: snapshot.approvals[0]!.id,
      decision: "always-project",
      client: "desktop",
    })

    expect(resolved).toMatchObject({
      result: {
        approvalRules: [expect.objectContaining({
          createdBy: "web",
          createdByConnectionId: firstConnectionId,
        })],
        thread: expect.arrayContaining([expect.objectContaining({
          kind: "receipt",
          client: "web",
          connectionId: firstConnectionId,
        })]),
      },
    })
    first.socket.close()
    second.socket.close()
  })

  it("activates an existing session and rejects unknown sessions", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const responseFor = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })

    const activated = responseFor(1)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.activate",
      params: { sessionId: "session-audit", client: "desktop" },
    }))
    await expect(activated).resolves.toMatchObject({
      result: { activeSessionId: "session-audit" },
    })

    const rejected = responseFor(2)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.activate",
      params: { sessionId: "session-missing", client: "desktop" },
    }))
    await expect(rejected).resolves.toMatchObject({
      error: { code: -32602, message: "Session does not exist" },
    })
    socket.close()
  })

  it("creates, replies to, and resolves anchored annotations", async () => {
    const cropRef = `crop-${"a".repeat(64)}`
    const annotationVisualContext = {
      capture: vi.fn(),
      storeUpload: vi.fn(async (input: { artifactRevision: number }) => ({
        status: "available" as const,
        ref: cropRef,
        artifactRevision: input.artifactRevision,
        mimeType: "image/png" as const,
        width: 4,
        height: 4,
        byteLength: 12,
      })),
      read: vi.fn(),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
      annotationVisualContext,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const created = await rpc("annotation.create", {
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-c",
      anchor: { textQuote: "Replay operations", bbox: { x: 10, y: 20, width: 4, height: 4 } },
      body: "Keep the progress visible.",
      visualContextUpload: {
        artifactRevision: 2,
        mimeType: "image/png",
        width: 4,
        height: 4,
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).toString("base64"),
      },
      client: "tablet",
    })
    const annotations = (created.result as { annotations: Array<{ id: string }> }).annotations
    const annotationId = annotations.at(-1)!.id
    expect(annotations.at(-1)).toMatchObject({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      origin: "tablet",
      status: "open",
      thread: [],
      visualContext: { status: "available", ref: cropRef, artifactRevision: 2 },
    })
    expect(annotationVisualContext.storeUpload).toHaveBeenCalledWith(expect.objectContaining({
      artifactRevision: 2,
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
    }))

    const stale = await rpc("annotation.create", {
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      anchor: { bbox: { x: 10, y: 20, width: 4, height: 4 } },
      body: "Stale crop.",
      visualContextUpload: {
        artifactRevision: 1,
        mimeType: "image/png",
        width: 4,
        height: 4,
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
      },
      client: "desktop",
    })
    expect(stale).toMatchObject({ error: { code: -32602, message: "Visual context revision is stale" } })

    const replied = await rpc("annotation.reply", {
      annotationId,
      body: "Updated in revision four.",
      client: "desktop",
    })
    expect(replied).toMatchObject({
      result: {
        annotations: expect.arrayContaining([expect.objectContaining({
          id: annotationId,
          thread: [expect.objectContaining({
            body: "Updated in revision four.",
            origin: "desktop",
          })],
        })]),
      },
    })

    const resolved = await rpc("annotation.setStatus", {
      annotationId,
      status: "resolved",
      client: "phone",
    })
    expect(resolved).toMatchObject({
      result: {
        annotations: expect.arrayContaining([expect.objectContaining({
          id: annotationId,
          status: "resolved",
          statusChangedBy: "phone",
        })]),
      },
    })
    socket.close()
  })

  it("sends unresolved annotations with the next agent turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "provider-thread-billing"
    snapshot.annotations[1]!.status = "resolved"
    const cropBytes = new Uint8Array([137, 80, 78, 71])
    snapshot.annotations[0]!.visualContext = {
      status: "available",
      ref: `crop-${"a".repeat(64)}`,
      artifactRevision: 3,
      mimeType: "image/png",
      width: 320,
      height: 56,
      byteLength: cropBytes.byteLength,
    }
    const annotationVisualContext = {
      capture: vi.fn(),
      storeUpload: vi.fn(),
      read: vi.fn(async () => cropBytes),
    }
    const agent = {
      capabilities: { vision: true },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "provider-thread-unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => "provider-turn-review"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      annotationVisualContext,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.send",
      params: {
        sessionId: "session-billing",
        prompt: "Revise the migration plan.",
        client: "desktop",
      },
    }))

    await expect(response).resolves.toMatchObject({ result: { activeSessionId: "session-billing" } })
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "provider-thread-billing",
      prompt: expect.stringContaining('"annotationId":"annotation-migration-machine"'),
      visualContexts: [{
        annotationId: "annotation-migration-machine",
        mimeType: "image/png",
        bytes: cropBytes,
      }],
    }))
    expect(agent.startTurn.mock.calls[0]![0].prompt).toContain('"delivery":"image-attached"')
    expect(annotationVisualContext.read).toHaveBeenCalledWith(`crop-${"a".repeat(64)}`, "image/png")
    expect(agent.startTurn.mock.calls[0]![0].prompt).not.toContain("annotation-replay-copy")
    socket.close()
  })

  it("reloads reviewed skills for new and steered turns without changing context order", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "provider-thread-billing"
    snapshot.thread = snapshot.thread.filter((item) => item.id !== "thread-assistant")
    const enabledSkill: SkillSummary = {
      id: "skill-4d6f4d6f4d6f",
      name: "repo-audit",
      description: "Audit a repository.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
      scope: "user",
      source: "agents",
      ...skillSecurityMetadata,
    }
    snapshot.skillEnablements = [{
      projectId: snapshot.project!.id,
      skillId: enabledSkill.id,
      enabled: true,
      contentDigest: enabledSkill.contentDigest,
      manifest: enabledSkill.manifest,
      reviewedAt: "2026-08-30T00:00:00.000Z",
      reviewedBy: { client: "desktop", clientId: "reviewer" },
    }]
    const skillCatalog = {
      list: vi.fn(async () => [enabledSkill]),
      read: vi.fn(async () => ({ skill: enabledSkill, content: "Audit every repository change." })),
    } satisfies SkillCatalog
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "provider-thread-unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => "provider-turn-review"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const send = (id: number, prompt: string) => new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", onMessage)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", onMessage)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session.send",
        params: { sessionId: session.id, prompt, client: "desktop" },
      }))
    })

    await expect(send(1, "Begin the audit")).resolves.toHaveProperty("result")
    const initialPrompt = agent.startTurn.mock.calls[0]![0].prompt
    expect(initialPrompt).toContain("Audit every repository change.")
    expect(initialPrompt.indexOf("<domovoi_skill_context>"))
      .toBeLessThan(initialPrompt.indexOf("<domovoi_review_context>"))
    expect(initialPrompt.indexOf("<domovoi_review_context>"))
      .toBeLessThan(initialPrompt.indexOf("<domovoi_handoff_context>"))
    expect(initialPrompt.indexOf("<domovoi_handoff_context>"))
      .toBeLessThan(initialPrompt.lastIndexOf("Begin the audit"))

    await expect(send(2, "Focus on manifests")).resolves.toHaveProperty("result")
    expect(agent.steerTurn).toHaveBeenCalledWith(
      "provider-thread-billing",
      "provider-turn-review",
      expect.stringContaining("Audit every repository change."),
    )
    expect(skillCatalog.read).toHaveBeenCalledTimes(2)
    socket.close()
  })

  it("omits untrusted enabled skills without blocking Build auto turns", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const newTurn = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    const steeredTurn = snapshot.sessions.find((candidate) => candidate.id === "session-onboarding")!
    for (const session of [newTurn, steeredTurn]) {
      session.runtime = {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        permissionMode: "build",
        auto: true,
      }
      session.workspacePath = `/worktrees/${session.id}`
      session.providerThreadId = `provider-${session.id}`
    }
    steeredTurn.activeTurnId = "provider-turn-active"
    const activateTurns = deferLiveTurns(snapshot)
    const enabledSkill: SkillSummary = {
      id: "skill-4d6f4d6f4d6f",
      name: "repo-audit",
      description: "Audit a repository.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
      scope: "user",
      source: "agents",
      ...skillSecurityMetadata,
    }
    snapshot.skillEnablements = [{
      projectId: snapshot.project!.id,
      skillId: enabledSkill.id,
      enabled: true,
      contentDigest: enabledSkill.contentDigest,
      manifest: enabledSkill.manifest,
      reviewedAt: "2026-08-30T00:00:00.000Z",
      reviewedBy: { client: "desktop", clientId: "reviewer" },
    }]
    const skillCatalog = {
      list: vi.fn(async () => [enabledSkill]),
      read: vi.fn(async () => ({ skill: enabledSkill, content: "Audit every change." })),
    } satisfies SkillCatalog
    const agent = {
      permissionCapabilities: { ask: "read-only" as const, buildAuto: "pre-execution" as const },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
      agent,
      skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const send = (id: number, sessionId: string) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session.send",
        params: { sessionId, prompt: "Run the audit", client: "desktop" },
      }))
    })

    await expect(send(1, newTurn.id)).resolves.toHaveProperty("result")
    await expect(send(2, steeredTurn.id)).resolves.toHaveProperty("result")
    expect(skillCatalog.read).toHaveBeenCalledTimes(2)
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.not.stringContaining("Audit every change."),
    }))
    expect(agent.steerTurn).toHaveBeenCalledWith(
      steeredTurn.providerThreadId,
      "provider-turn-active",
      expect.not.stringContaining("Audit every change."),
    )
    socket.close()
  })

  it("keeps reviewed unsigned skills usable in Plan and Build manual", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const plan = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    const manual = snapshot.sessions.find((candidate) => candidate.id === "session-onboarding")!
    plan.runtime = {
      provider: "codex", model: "gpt-5.6-sol", reasoning: "medium",
      permissionMode: "plan", auto: false,
    }
    manual.runtime = {
      provider: "codex", model: "gpt-5.6-sol", reasoning: "medium",
      permissionMode: "build", auto: false,
    }
    for (const session of [plan, manual]) {
      session.workspacePath = `/worktrees/${session.id}`
      session.providerThreadId = `provider-${session.id}`
    }
    manual.activeTurnId = "provider-turn-active"
    const activateTurns = deferLiveTurns(snapshot)
    const enabledSkill: SkillSummary = {
      id: "skill-4d6f4d6f4d6f", name: "repo-audit", description: "Audit a repository.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md", scope: "user", source: "agents",
      ...skillSecurityMetadata,
    }
    snapshot.skillEnablements = [{
      projectId: snapshot.project!.id, skillId: enabledSkill.id, enabled: true,
      contentDigest: enabledSkill.contentDigest, manifest: enabledSkill.manifest,
      reviewedAt: "2026-08-30T00:00:00.000Z", reviewedBy: { client: "desktop" },
    }]
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "provider-turn"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const skillCatalog = {
      list: vi.fn(async () => [enabledSkill]),
      read: vi.fn(async () => ({ skill: enabledSkill, content: "Audit every change." })),
    } satisfies SkillCatalog
    const daemon = new DomovoiDaemon({
      port: 0, store: { load: () => snapshot, save: vi.fn(), close: vi.fn() }, agent, skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const send = (id: number, sessionId: string) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id, method: "session.send",
        params: { sessionId, prompt: "Run the audit", client: "desktop" },
      }))
    })

    await expect(send(1, plan.id)).resolves.toHaveProperty("result")
    await expect(send(2, manual.id)).resolves.toHaveProperty("result")
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Audit every change."),
    }))
    expect(agent.steerTurn).toHaveBeenCalledWith(
      manual.providerThreadId,
      "provider-turn-active",
      expect.stringContaining("Audit every change."),
    )
    socket.close()
  })

  it("quarantines retries until a timed-out connection reset settles", async () => {
    let finishConnect: (() => void) | undefined
    let finishReset: (() => void) | undefined
    const errorSink = vi.fn()
    const agent = {
      connect: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishConnect = resolve }))
        .mockResolvedValue(undefined),
      resetConnection: vi.fn(() => new Promise<void>((resolve) => { finishReset = resolve })),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agent,
      agentTimeoutMs: 100,
      errorSink,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const rpc = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runtime.models",
        params: { provider: "codex", client: "desktop" },
      }))
    })

    const timedOut = rpc(1)
    await vi.waitFor(() => expect(agent.resetConnection).toHaveBeenCalledOnce())
    expect(agent.close).not.toHaveBeenCalled()
    await expect(timedOut).resolves.toMatchObject({ error: { message: "Agent setup timed out" } })
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Agent provider codex connection reset failed",
      detail: expect.stringContaining("Agent connection reset timed out"),
    }))

    const retry = rpc(2)
    finishConnect!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agent.listModels).not.toHaveBeenCalled()
    expect(agent.connect).toHaveBeenCalledOnce()

    finishReset!()
    await expect(retry).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    expect(agent.connect).toHaveBeenCalledTimes(2)
    expect(agent.listModels).toHaveBeenCalledOnce()
    socket.close()
  })

  it("retries timed-out setup without closing adapters that cannot reset", async () => {
    let finishConnect: (() => void) | undefined
    const agent = {
      connect: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishConnect = resolve }))
        .mockResolvedValue(undefined),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agent,
      agentTimeoutMs: 100,
      errorSink: vi.fn(),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const rpc = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runtime.models",
        params: { provider: "codex", client: "desktop" },
      }))
    })

    await expect(rpc(1)).resolves.toMatchObject({ error: { message: "Agent setup timed out" } })
    expect(agent.close).not.toHaveBeenCalled()
    finishConnect!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(rpc(2)).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    expect(agent.connect).toHaveBeenCalledTimes(2)
    expect(agent.listModels).toHaveBeenCalledOnce()
    expect(agent.close).not.toHaveBeenCalled()
    socket.close()
  })

  it("retries model discovery after an empty catalog", async () => {
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue(codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", agent })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const rpc = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runtime.models",
        params: { provider: "codex", client: "desktop" },
      }))
    })

    await expect(rpc(1)).resolves.toMatchObject({ result: [] })
    await expect(rpc(2)).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    expect(agent.listModels).toHaveBeenCalledTimes(2)
    socket.close()
  })

  it("rejects browser connections from an untrusted origin", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()

    const status = await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
        origin: "https://malicious.example",
      })
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode))
      socket.once("error", () => resolve(undefined))
    })

    expect(status).toBe(401)
  })

  it("rejects an unexplained denial and records a supplied explanation", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.activeSessionId = "session-onboarding"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    await identifyClient(socket, "web")

    const nextResponse = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })

    const invalidResponse = nextResponse(1)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: { approvalId: "approval-migrate", decision: "deny-explain", client: "web" },
    }))
    await expect(invalidResponse).resolves.toMatchObject({
      error: { code: -32602, message: "Method parameters are invalid" },
    })

    const explainedResponse = nextResponse(2)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "approval.resolve",
      params: {
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "web",
        explanation: "Run this against staging before production.",
      },
    }))
    await expect(explainedResponse).resolves.toMatchObject({
      result: {
        approvals: [],
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", state: "idle" }),
          expect.objectContaining({ id: "session-onboarding", state: "active" }),
        ]),
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "receipt",
            decision: "deny-explain",
            explanation: "Run this against staging before production.",
            client: "web",
          }),
        ]),
      },
    })
    socket.close()
  })

  it("restores JSON-RPC mutations after a daemon restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-daemon-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const initial = structuredClone(demoWorkspace)
    const restoredSession = initial.sessions.find((session) => session.id === "session-billing")!
    restoredSession.runtime.provider = "codex"
    restoredSession.runtime.model = "gpt-5.6-sol"
    restoredSession.workspacePath = "/worktrees/session-billing"
    restoredSession.providerThreadId = "provider-thread-restored"
    const persistedAgent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const first = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(statePath, initial),
      agent: persistedAgent,
    })
    running.push(first)
    const firstAddress = await first.start()
    const firstSocket = authenticatedSocket(
      first,
      `ws://${firstAddress.host}:${firstAddress.port}/rpc`,
    )
    await new Promise<void>((resolve, reject) => {
      firstSocket.once("open", resolve)
      firstSocket.once("error", reject)
    })
    const mutation = new Promise<void>((resolve) => {
      firstSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve()
      })
    })
    firstSocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.setRuntime",
      params: {
        sessionId: "session-billing",
        runtime: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoning: "medium",
          permissionMode: "plan",
          auto: false,
        },
        client: "desktop",
      },
    }))
    await mutation
    firstSocket.close()
    await first.stop()
    running.splice(running.indexOf(first), 1)

    const resumedAgent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-after-restart"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const second = new DomovoiDaemon({ port: 0, statePath, agent: resumedAgent })
    running.push(second)
    const secondAddress = await second.start()
    const secondSocket = authenticatedSocket(
      second,
      `ws://${secondAddress.host}:${secondAddress.port}/rpc`,
    )
    const restored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      secondSocket.once("error", reject)
      secondSocket.once("open", () => {
        secondSocket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "system.hello",
          params: { client: "desktop", clientVersion: "0.0.1" },
        }))
      })
      secondSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })

    expect(restored).toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({
            id: "session-billing",
            runtime: expect.objectContaining({
              provider: "codex",
              model: "gpt-5.6-sol",
              permissionMode: "plan",
            }),
          }),
        ]),
      },
    })
    const continued = new Promise<Record<string, unknown>>((resolve) => {
      secondSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 3) resolve(message as Record<string, unknown>)
      })
    })
    secondSocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.send",
      params: {
        sessionId: "session-billing",
        prompt: "Continue after restart",
        client: "desktop",
      },
    }))
    await expect(continued).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", activeTurnId: "turn-after-restart" }),
        ]),
      },
    })
    expect(resumedAgent.resumeThread).toHaveBeenCalledOnce()
    expect(resumedAgent.resumeThread).toHaveBeenCalledWith({
      threadId: "provider-thread-restored",
      cwd: "/worktrees/session-billing",
      runtime: expect.objectContaining({
        provider: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "plan",
      }),
    })
    expect(resumedAgent.resumeThread.mock.invocationCallOrder[0]).toBeLessThan(
      resumedAgent.startTurn.mock.invocationCallOrder[0]!,
    )
    secondSocket.close()
  })

  it("orchestrates a local project, Codex turn, approval, and checkpoint", async () => {
    const agentListeners = new Set<(event: AgentEvent) => void>()
    const errorEntries: Array<{ context: string; detail: string }> = []
    let resolveTimedOutThread: ((threadId: string) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn()
        .mockImplementationOnce(() => new Promise<string>((resolve) => {
          resolveTimedOutThread = resolve
        }))
        .mockResolvedValue("provider-thread-1"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-1"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(async (path: string, _signal?: AbortSignal) => ({
        root: path === "/code/elsewhere" ? "/code/elsewhere" : "/code/domovoi",
        name: path === "/code/elsewhere" ? "elsewhere" : "domovoi",
        branch: path === "/code/elsewhere" ? "develop" : "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async (
        _path: string,
        _label: string,
        _signal?: AbortSignal,
      ) => ({ commit: "b".repeat(40), changedFiles: ["src/app.ts"] })),
      restore: vi.fn(async () => ({
        restoredCommit: "b".repeat(40),
        recoveryCommit: "c".repeat(40),
      })),
    } satisfies WorkspaceService
    const initialSnapshot = createEmptyWorkspace({
      id: "machine-orchestration",
      name: "orchestration-test",
      platform: process.platform,
      arch: process.arch,
      version: "0.0.1",
      connection: "local",
      reachable: true,
      providers: [],
    })
    const store = {
      load: vi.fn(() => structuredClone(initialSnapshot)),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agent },
      workspaceService,
      agentTimeoutMs: 100,
      modelCacheTtlMs: 0,
      errorSink: (entry) => errorEntries.push(entry),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const notifications: Array<{ method?: string; params?: unknown }> = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method?: string; params?: unknown }
      if (message.method) notifications.push(message)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const listedModels = await rpc("runtime.models", {
      provider: "codex",
      client: "desktop",
    })
    expect(listedModels).toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol", provider: "codex" })],
    })
    await rpc("runtime.models", { provider: "codex", client: "desktop" })
    expect(agent.listModels).toHaveBeenCalledTimes(2)

    const opened = await rpc("project.open", { path: "/code/domovoi", client: "desktop" })
    expect(opened).toMatchObject({
      result: { project: { name: "domovoi", path: "/code/domovoi", branch: "main" } },
    })

    const runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    const timedOut = await rpc("session.create", {
      title: "Timeout setup",
      runtime,
      client: "desktop",
    })
    expect(timedOut).toMatchObject({ error: { code: -32603, message: "Agent setup timed out" } })
    expect(errorEntries).toEqual([
      expect.objectContaining({
        context: "RPC session.create timed out",
        detail: expect.stringContaining("OperationTimeoutError: Agent setup timed out"),
      }),
    ])
    expect(workspaceService.removeSessionWorkspace).toHaveBeenCalledOnce()
    resolveTimedOutThread!("provider-thread-after-timeout")
    await vi.waitFor(() => expect(agent.stopThread).toHaveBeenCalledWith(
      "provider-thread-after-timeout",
    ))

    workspaceService.inspect.mockImplementationOnce(
      (_path: string, signal?: AbortSignal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    )
    const inspectionTimedOut = await rpc("session.create", {
      title: "Timeout inspection",
      runtime,
      client: "desktop",
    })
    expect(inspectionTimedOut).toMatchObject({
      error: { code: -32603, message: "Repository inspection timed out" },
    })

    const created = await rpc("session.create", {
      title: "Build persistence",
      runtime: { ...runtime, model: "default" },
      client: "desktop",
    })
    const createdResult = created.result as { activeSessionId: string; sessions: Array<{ id: string }> }
    const sessionId = createdResult.activeSessionId
    expect(createdResult.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        workspacePath: `/worktrees/${sessionId}`,
        providerThreadId: "provider-thread-1",
      }),
    ])
    expect(agent.startThread).toHaveBeenCalledWith({
      cwd: `/worktrees/${sessionId}`,
      runtime,
    })

    await rpc("session.send", {
      sessionId,
      prompt: "Run the tests",
      client: "desktop",
    })
    expect(agent.startTurn).toHaveBeenCalledWith({
      threadId: "provider-thread-1",
      cwd: `/worktrees/${sessionId}`,
      prompt: "Run the tests",
      runtime,
    })

    await rpc("session.send", {
      sessionId,
      prompt: "Focus on the failing test first",
      client: "desktop",
    })
    expect(agent.startTurn).toHaveBeenCalledOnce()
    expect(agent.steerTurn).toHaveBeenCalledWith(
      "provider-thread-1",
      "provider-turn-1",
      "Focus on the failing test first",
    )

    await rpc("workspace.get", {})
    notifications.length = 0
    const savesBeforeStream = store.save.mock.calls.length
    for (const listener of agentListeners) {
      listener({
        type: "text-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "Tests are green.",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "1. Inspect the failing test.\n",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "2. Fix the implementation.",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "\n3. Verify the next turn.",
      })
    }
    await vi.waitFor(() => expect(notifications.filter(
      (notification) => notification.method === "workspace.delta",
    )).toHaveLength(4))
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(savesBeforeStream + 1))
    expect(notifications).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "workspace.changed" }),
    ]))
    expect(notifications.find((notification) => notification.method === "workspace.delta"))
      .toMatchObject({
        params: {
          sessionId,
          operations: [expect.objectContaining({
            kind: "assistant.append",
            delta: "Tests are green.",
          })],
        },
      })
    for (const listener of agentListeners) {
      listener({
        type: "approval-requested",
        requestId: 71,
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        itemId: "command-1",
        command: "pnpm build",
        cwd: `/worktrees/${sessionId}`,
        reason: "Build the project",
      })
    }
    const streamed = await rpc("workspace.get", {})
    expect(streamed).toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", body: "Tests are green." }),
        ]),
        artifacts: [expect.objectContaining({
          sessionId,
          type: "plan",
          revision: 3,
          mimeType: "text/markdown",
          content: "1. Inspect the failing test.\n2. Fix the implementation.\n3. Verify the next turn.",
        })],
        approvals: [expect.objectContaining({ providerRequestId: 71, command: "pnpm build" })],
      },
    })

    const approvalId = (streamed.result as { approvals: Array<{ id: string }> }).approvals[0]!.id
    await rpc("approval.resolve", {
      approvalId,
      decision: "allow-once",
      client: "desktop",
    })
    expect(agent.resolveApproval).toHaveBeenCalledWith(71, "allow-once")

    const activeCheckpoint = await rpc("checkpoint.create", {
      sessionId,
      label: "while-agent-is-running",
      client: "desktop",
    })
    expect(activeCheckpoint).toMatchObject({
      error: { code: -32602, message: "Stop the active turn before creating a checkpoint" },
    })
    expect(workspaceService.checkpoint).not.toHaveBeenCalled()

    const activeRestore = await rpc("checkpoint.restore", {
      sessionId,
      checkpointId: "checkpoint-active-turn",
      client: "desktop",
    })
    expect(activeRestore).toMatchObject({
      error: { code: -32602, message: "Stop the active turn before restoring a checkpoint" },
    })

    const unsupportedRuntime = await rpc("session.setRuntime", {
      sessionId,
      runtime: { ...runtime, provider: "claude-code", model: "sonnet-4.6" },
      client: "desktop",
    })
    expect(unsupportedRuntime).toMatchObject({
      error: { code: -32602, message: "Stop the active turn before changing providers" },
    })

    const unsupportedReasoning = await rpc("session.setRuntime", {
      sessionId,
      runtime: { ...runtime, reasoning: "impossible" },
      client: "desktop",
    })
    expect(unsupportedReasoning).toMatchObject({
      error: {
        code: -32602,
        message: "Reasoning effort is not supported by the selected model",
      },
    })

    for (const listener of agentListeners) {
      listener({
        type: "turn-completed",
        params: {
          threadId: "provider-thread-1",
          turnId: "provider-turn-1",
          turn: { id: "provider-turn-1", status: "completed" },
        },
      })
    }
    await rpc("workspace.get", {})

    let checkpointAborted = false
    workspaceService.checkpoint.mockImplementationOnce(
      (_path: string, _label: string, signal?: AbortSignal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          checkpointAborted = true
          reject(signal.reason)
        }, { once: true })
      }),
    )
    const timedOutCheckpoint = await rpc("checkpoint.create", {
      sessionId,
      label: "must-time-out",
      client: "desktop",
    })
    expect(timedOutCheckpoint).toMatchObject({
      error: { code: -32603, message: "Checkpoint timed out" },
    })
    expect(checkpointAborted).toBe(true)

    const checkpointed = await rpc("checkpoint.create", {
      sessionId,
      label: "after-tests",
      client: "desktop",
    })
    expect(checkpointed).toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "checkpoint",
            label: expect.stringContaining("after-tests"),
            commit: "b".repeat(40),
          }),
        ]),
      },
    })
    const checkpointId = (checkpointed.result as {
      thread: Array<{ id: string; kind: string }>
    }).thread.find((item) => item.kind === "checkpoint")!.id

    const unknownRestore = await rpc("checkpoint.restore", {
      sessionId,
      checkpointId: "checkpoint-missing",
      client: "desktop",
    })
    expect(unknownRestore).toMatchObject({
      error: { code: -32602, message: "Checkpoint cannot be restored" },
    })

    const restored = await rpc("checkpoint.restore", {
      sessionId,
      checkpointId,
      client: "desktop",
    })
    expect(workspaceService.restore).toHaveBeenCalledWith(
      `/worktrees/${sessionId}`,
      "b".repeat(40),
      expect.any(AbortSignal),
    )
    expect(restored).toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "system",
            body: "Worktree restored",
            detail: expect.stringContaining("Recovery checkpoint cccccccc"),
          }),
        ]),
      },
    })

    let resolveLateTurn: ((turnId: string) => void) | undefined
    agent.startTurn.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveLateTurn = resolve }),
    )
    const lateTurn = rpc("session.send", {
      sessionId,
      prompt: "Continue after project switch",
      client: "desktop",
    })
    await vi.waitFor(() => expect(agent.startTurn).toHaveBeenCalledTimes(2))
    const reopening = rpc("project.open", { path: "/code/domovoi/.", client: "desktop" })
    expect(agent.stopThread).not.toHaveBeenCalledWith("provider-thread-1")
    resolveLateTurn!("late-turn")
    await expect(lateTurn).resolves.toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({ kind: "user", body: "Continue after project switch" }),
        ]),
      },
    })
    const reopened = await reopening
    expect(reopened).toMatchObject({
      result: {
        project: { path: "/code/domovoi", branch: "main" },
        activeSessionId: sessionId,
        sessions: [expect.objectContaining({ id: sessionId })],
      },
    })
    expect(agent.stopThread).not.toHaveBeenCalledWith("provider-thread-1")
    expect(workspaceService.removeSessionWorkspace).not.toHaveBeenCalledWith(
      `/worktrees/${sessionId}`,
      expect.any(AbortSignal),
    )

    agent.stopThread.mockClear()
    workspaceService.removeSessionWorkspace.mockClear()
    const savesBeforeRejectedSwitch = store.save.mock.calls.length
    const rejectedSwitch = await rpc("project.open", { path: "/code/elsewhere", client: "desktop" })
    expect(rejectedSwitch).toMatchObject({
      error: {
        code: -32010,
        data: {
          kind: "project-switch-confirmation",
          requestedPath: "/code/elsewhere",
          sessionCount: 1,
          worktreeCount: 1,
          sessions: [{
            id: sessionId,
            title: "Build persistence",
            state: "active",
            workspacePath: `/worktrees/${sessionId}`,
          }],
        },
      },
    })
    expect(agent.stopThread).not.toHaveBeenCalled()
    expect(workspaceService.removeSessionWorkspace).not.toHaveBeenCalled()
    expect(store.save).toHaveBeenCalledTimes(savesBeforeRejectedSwitch)

    const firstConfirmation = projectSwitchConfirmationSchema.parse(
      (rejectedSwitch.error as { data?: unknown }).data,
    )
    const racedSession = await rpc("session.create", {
      title: "Created while confirmation was open",
      runtime,
      client: "desktop",
    })
    expect(racedSession).toMatchObject({
      result: { sessions: expect.arrayContaining([
        expect.objectContaining({ title: "Created while confirmation was open" }),
      ]) },
    })
    agent.stopThread.mockClear()
    workspaceService.removeSessionWorkspace.mockClear()
    const savesBeforeStaleConfirmation = store.save.mock.calls.length
    const staleConfirmation = await rpc("project.open", {
      path: "/code/elsewhere",
      client: "desktop",
      confirmation: firstConfirmation,
    })
    expect(staleConfirmation).toMatchObject({
      error: {
        code: -32010,
        data: { sessionCount: 2, worktreeCount: 2 },
      },
    })
    expect(agent.stopThread).not.toHaveBeenCalled()
    expect(workspaceService.removeSessionWorkspace).not.toHaveBeenCalled()
    expect(store.save).toHaveBeenCalledTimes(savesBeforeStaleConfirmation)

    const currentConfirmation = projectSwitchConfirmationSchema.parse(
      (staleConfirmation.error as { data?: unknown }).data,
    )

    const switched = await rpc("project.open", {
      path: "/code/elsewhere",
      client: "desktop",
      confirmation: currentConfirmation,
    })
    expect(switched).toMatchObject({
      result: {
        project: { name: "elsewhere", path: "/code/elsewhere", branch: "develop" },
        activeSessionId: null,
        sessions: [],
      },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("provider-thread-1")
    expect(workspaceService.removeSessionWorkspace).toHaveBeenCalledWith(
      `/worktrees/${sessionId}`,
      expect.any(AbortSignal),
    )

    const quarantineCreated = await rpc("session.create", {
      title: "Quarantine timed-out turn",
      runtime,
      client: "desktop",
    })
    const quarantineSessionId = (quarantineCreated.result as {
      activeSessionId: string
    }).activeSessionId
    agent.stopThread.mockClear()
    let resolveTimedOutTurn: ((turnId: string) => void) | undefined
    agent.startTurn.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveTimedOutTurn = resolve
    }))
    const turnTimedOut = await rpc("session.send", {
      sessionId: quarantineSessionId,
      prompt: "This turn must be quarantined",
      client: "desktop",
    })
    expect(turnTimedOut).toMatchObject({
      error: { code: -32603, message: "Agent turn timed out" },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("provider-thread-1")
    resolveTimedOutTurn!("provider-turn-after-timeout")
    for (const listener of agentListeners) {
      listener({
        type: "text-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-after-timeout",
        delta: "must not be recorded",
      })
      listener({
        type: "text-delta",
        delta: "unscoped event must not be recorded",
      })
    }
    const quarantined = await rpc("workspace.get", {})
    expect(quarantined).toMatchObject({
      result: {
        sessions: [expect.objectContaining({
          id: quarantineSessionId,
          state: "failed",
        })],
        thread: expect.arrayContaining([expect.objectContaining({
          sessionId: quarantineSessionId,
          kind: "system",
          body: "Provider thread quarantined after Agent turn timed out.",
        })]),
      },
    })
    expect((quarantined.result as {
      sessions: Array<{ providerThreadId?: string }>
      thread: Array<{ body?: string }>
    }).sessions[0]).not.toHaveProperty("providerThreadId")
    expect((quarantined.result as {
      thread: Array<{ body?: string }>
    }).thread).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ body: "must not be recorded" }),
    ]))
    expect((quarantined.result as {
      thread: Array<{ body?: string }>
    }).thread).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ body: "unscoped event must not be recorded" }),
    ]))

    const restarted = await rpc("session.restartProviderThread", {
      sessionId: quarantineSessionId,
      client: "web",
    })
    expect(restarted).toMatchObject({
      result: {
        sessions: [expect.objectContaining({
          id: quarantineSessionId,
          state: "idle",
          providerThreadId: "provider-thread-1",
        })],
        thread: expect.arrayContaining([expect.objectContaining({
          sessionId: quarantineSessionId,
          kind: "system",
          body: "Provider thread restarted by desktop.",
          detail: expect.stringContaining("worktree, history, checkpoints, artifacts, and annotations were preserved"),
        })]),
      },
    })
    expect(agent.startThread).toHaveBeenLastCalledWith({
      cwd: `/worktrees/${quarantineSessionId}`,
      runtime,
    })
    expect(await rpc("session.restartProviderThread", {
      sessionId: quarantineSessionId,
      client: "desktop",
    })).toMatchObject({
      error: { code: -32602, message: "Session already has a live provider thread" },
    })

    const steeringCreated = await rpc("session.create", {
      title: "Quarantine timed-out steering",
      runtime,
      client: "desktop",
    })
    const steeringSessionId = (steeringCreated.result as {
      activeSessionId: string
    }).activeSessionId
    await rpc("session.send", {
      sessionId: steeringSessionId,
      prompt: "Begin an active turn",
      client: "desktop",
    })
    agent.stopThread.mockClear()
    agent.steerTurn.mockImplementationOnce(() => new Promise<void>(() => {}))
    const steeringTimedOut = await rpc("session.send", {
      sessionId: steeringSessionId,
      prompt: "This steering request must be quarantined",
      client: "desktop",
    })
    expect(steeringTimedOut).toMatchObject({
      error: { code: -32603, message: "Agent steering timed out" },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("provider-thread-1")
    const steeringQuarantined = await rpc("workspace.get", {})
    expect(steeringQuarantined).toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: steeringSessionId,
          state: "failed",
        })]),
        thread: expect.arrayContaining([expect.objectContaining({
          sessionId: steeringSessionId,
          kind: "system",
          body: "Provider thread quarantined after Agent steering timed out.",
        })]),
      },
    })
    const steeringSession = (steeringQuarantined.result as {
      sessions: Array<{ id: string; providerThreadId?: string }>
    }).sessions.find((session) => session.id === steeringSessionId)
    expect(steeringSession).toBeDefined()
    expect(steeringSession).not.toHaveProperty("providerThreadId")
    agent.stopThread.mockClear()
    store.save.mockImplementationOnce(() => { throw new Error("disk full") })
    expect(await rpc("session.restartProviderThread", {
      sessionId: steeringSessionId,
      client: "web",
    })).toMatchObject({
      error: { code: -32603, message: "Internal daemon error" },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("provider-thread-1")
    expect(await rpc("workspace.get", {})).toMatchObject({
      result: { sessions: expect.arrayContaining([expect.objectContaining({
        id: steeringSessionId,
        state: "failed",
      })]) },
    })
    expect((await rpc("workspace.get", {}) as { result: { sessions: Array<{ id: string; providerThreadId?: string }> } })
      .result.sessions.find(({ id }) => id === steeringSessionId)).not.toHaveProperty("providerThreadId")
    agent.stopThread.mockClear()
    let resolveLateRestart: ((threadId: string) => void) | undefined
    agent.startThread.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveLateRestart = resolve
    }))
    expect(await rpc("session.restartProviderThread", {
      sessionId: steeringSessionId,
      client: "desktop",
    })).toMatchObject({
      error: { code: -32603, message: "Provider restart timed out" },
    })
    resolveLateRestart!("late-restart-thread")
    await vi.waitFor(() => expect(agent.stopThread).toHaveBeenCalledWith("late-restart-thread"))
    expect((await rpc("workspace.get", {}) as { result: { sessions: Array<{ id: string; providerThreadId?: string }> } })
      .result.sessions.find(({ id }) => id === steeringSessionId)).not.toHaveProperty("providerThreadId")
    socket.close()
  })

  it("rejects provider restart outside a recoverable session", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const noWorktree = snapshot.sessions[0]!
    noWorktree.state = "failed"
    delete noWorktree.workspacePath
    delete noWorktree.providerThreadId
    const archived = snapshot.sessions[1]!
    archived.state = "archived"
    archived.archiveRequestedAt = "2026-08-31T12:00:00.000Z"
    archived.archiveCheckpoint = "a".repeat(40)
    archived.archivedAt = "2026-08-31T12:01:00.000Z"
    delete archived.workspacePath
    delete archived.providerThreadId
    const live = snapshot.sessions[2]!
    live.workspacePath = "/worktrees/live"
    live.providerThreadId = "thread-live"
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      load: vi.fn(() => structuredClone(snapshot)),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agent })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const unauthenticated = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "session.restartProviderThread",
      params: { sessionId: noWorktree.id, client: "web" },
    }))
    await expect(unauthenticated).resolves.toMatchObject({
      error: { code: -32602, message: "Provider restart requires an authenticated connection identity" },
    })
    expect(agent.startThread).not.toHaveBeenCalled()
    await identifyClient(socket)
    let id = 0
    const rpc = (sessionId: string) => new Promise<Record<string, unknown>>((resolve) => {
      const requestId = ++id
      socket.on("message", function receive(data) {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      })
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id: requestId, method: "session.restartProviderThread",
        params: { sessionId, client: "desktop" },
      }))
    })

    await expect(rpc("missing")).resolves.toMatchObject({ error: { code: -32602, message: "Session does not exist" } })
    await expect(rpc(noWorktree.id)).resolves.toMatchObject({ error: { code: -32602, message: "Session has no worktree" } })
    await expect(rpc(archived.id)).resolves.toMatchObject({ error: { code: -32602, message: "Archived sessions are read-only" } })
    await expect(rpc(live.id)).resolves.toMatchObject({ error: { code: -32602, message: "Session already has a live provider thread" } })
    expect(agent.startThread).not.toHaveBeenCalled()
    socket.close()
  })

  it("routes model discovery and sessions through the requested provider adapter", async () => {
    const makeAgent = (models: ProviderModel[], threadId: string) => ({
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => models),
      startThread: vi.fn(async () => threadId),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter)
    const codex = makeAgent(codexModels(), "codex-thread")
    const claude = makeAgent([{
      ...codexModels()[0]!,
      provider: "claude-code",
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
    }], "claude-thread")
    const workspaceService = {
      inspect: vi.fn(async () => ({
        root: "/code/domovoi",
        name: "domovoi",
        branch: "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: [] })),
      restore: vi.fn(async () => ({
        restoredCommit: "b".repeat(40),
        recoveryCommit: "c".repeat(40),
      })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agents: { codex, "claude-code": claude },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await expect(rpc("runtime.models", {
      provider: "claude-code",
      client: "desktop",
    })).resolves.toMatchObject({
      result: [expect.objectContaining({ provider: "claude-code", id: "claude-sonnet-4-6" })],
    })
    await expect(rpc("runtime.models", {
      provider: "opencode",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Agent provider opencode is unavailable" },
    })
    await rpc("project.open", { path: "/code/domovoi", client: "desktop" })
    const created = await rpc("session.create", {
      title: "Claude session",
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        reasoning: "medium",
        permissionMode: "plan",
        auto: false,
      },
      client: "desktop",
    })
    const sessionId = (created.result as { activeSessionId: string }).activeSessionId

    expect(claude.connect).toHaveBeenCalledOnce()
    expect(claude.listModels).toHaveBeenCalledOnce()
    expect(claude.startThread).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ provider: "claude-code" }),
    }))
    expect(codex.connect).not.toHaveBeenCalled()
    expect(codex.startThread).not.toHaveBeenCalled()

    const handedOff = await rpc("session.setRuntime", {
      sessionId,
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
        permissionMode: "build",
        auto: false,
      },
      client: "desktop",
    })
    expect(handedOff).toMatchObject({
      result: {
        sessions: [expect.objectContaining({
          id: sessionId,
          providerThreadId: "codex-thread",
          runtime: expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol" }),
        })],
        thread: expect.arrayContaining([expect.objectContaining({
          kind: "system",
          body: "Handed off claude-code / claude-sonnet-4-6 to codex / gpt-5.6-sol.",
        })]),
      },
    })
    expect(workspaceService.checkpoint).toHaveBeenCalledWith(
      `/worktrees/${sessionId}`,
      "before provider handoff",
      expect.any(AbortSignal),
    )
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: `/worktrees/${sessionId}`,
      runtime: expect.objectContaining({ provider: "codex" }),
    }))
    expect(claude.stopThread).toHaveBeenCalledWith("claude-thread")

    await rpc("session.send", { sessionId, prompt: "Inspect the repository", client: "desktop" })
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "codex-thread",
      prompt: expect.stringMatching(/<domovoi_handoff_context>[\s\S]*Inspect the repository/),
      runtime: expect.objectContaining({ provider: "codex" }),
    }))
    expect(claude.startTurn).not.toHaveBeenCalled()

    await expect(rpc("session.setRuntime", {
      sessionId,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        reasoning: "medium",
        permissionMode: "plan",
        auto: false,
      },
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Stop the active turn before changing providers" },
    })
    expect(claude.startThread).toHaveBeenCalledOnce()
  })

  it("forks a checkpoint idempotently without mutating the source selection", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const source = snapshot.sessions.find((session) => session.id === "session-audit")!
    source.workspacePath = "/worktrees/session-audit"
    source.providerThreadId = "source-provider-thread"
    source.baseCommit = "6".repeat(40)
    const sourceCheckpoint = {
      id: "checkpoint-audit-fork",
      sessionId: source.id,
      kind: "checkpoint" as const,
      label: "88888888 · fork point",
      commit: "8".repeat(40),
      createdAt: "2026-08-29T12:00:00.000Z",
    }
    snapshot.thread.push(sourceCheckpoint)
    const waiting = {
      ...source,
      id: "session-waiting-fork",
      title: "Waiting source",
      state: "waiting" as const,
      workspacePath: "/worktrees/session-waiting-fork",
      providerThreadId: "waiting-provider-thread",
    }
    snapshot.sessions.push(waiting)
    snapshot.thread.push({
      id: "checkpoint-waiting-fork",
      sessionId: waiting.id,
      kind: "checkpoint",
      label: "aaaaaaaa · waiting",
      commit: "a".repeat(40),
      createdAt: "2026-08-29T12:00:00.000Z",
    })
    const active = snapshot.sessions.find((session) => session.id === "session-billing")!
    active.state = "active"
    active.workspacePath = "/worktrees/session-billing"
    active.providerThreadId = "active-provider-thread"
    const archived = snapshot.sessions.find((session) => session.id === "session-onboarding")!
    archived.state = "archived"
    archived.archiveRequestedAt = "2026-08-29T11:00:00.000Z"
    archived.archiveCheckpoint = "9".repeat(40)
    archived.archivedAt = "2026-08-29T11:01:00.000Z"
    delete archived.workspacePath
    delete archived.providerThreadId
    delete archived.activeTurnId
    snapshot.thread.push({
      id: "checkpoint-archived",
      sessionId: archived.id,
      kind: "checkpoint",
      label: "99999999 · archived",
      commit: "9".repeat(40),
      createdAt: archived.archivedAt,
    })
    const sourceBefore = structuredClone(source)
    const activeSelection = snapshot.activeSessionId
    const errorSink = vi.fn()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn()
        .mockRejectedValueOnce(new Error("fork setup failed"))
        .mockResolvedValue("fork-provider-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const createSessionWorkspaceFromCheckpoint = vi.fn(async (
      _sourcePath: string,
      commit: string,
      sessionId: string,
    ) => ({
      path: `/worktrees/${sessionId}`,
      branch: `domovoi/${sessionId}`,
      baseCommit: commit,
    }))
    const removeSessionWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error("cleanup race"))
      .mockResolvedValue(undefined)
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      createSessionWorkspaceFromCheckpoint,
      removeSessionWorkspace,
      checkpoint: vi.fn(),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const save = vi.fn().mockImplementationOnce(() => {
      throw new Error("fork persistence failed")
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "fork-token",
      store: { load: () => structuredClone(snapshot), save, close: vi.fn() },
      agents: { codex: agent },
      workspaceService,
      errorSink,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let rpcId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++rpcId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    const runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    const requestedRuntime = { ...runtime, model: "default" }
    const forkParams = {
      sessionId: source.id,
      checkpointId: sourceCheckpoint.id,
      requestId: "fork-request-audit",
      runtime: requestedRuntime,
      client: "desktop",
    }

    await expect(rpc("session.fork", { ...forkParams, sessionId: active.id })).resolves.toMatchObject({
      error: { code: -32602, message: "Stop the active turn before forking a session" },
    })
    await expect(rpc("session.fork", {
      ...forkParams,
      sessionId: waiting.id,
      checkpointId: "checkpoint-waiting-fork",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Wait for the pending session mutation before forking" },
    })
    await expect(rpc("session.fork", { ...forkParams, sessionId: archived.id, checkpointId: "checkpoint-archived" })).resolves.toMatchObject({
      error: { code: -32602, message: "Archived sessions are read-only" },
    })
    await expect(rpc("session.fork", { ...forkParams, runtime: { ...runtime, model: "missing" } })).resolves.toMatchObject({
      error: { code: -32602, message: "Model is not available from codex" },
    })
    await expect(rpc("session.fork", forkParams)).resolves.toMatchObject({
      error: { code: -32603 },
    })
    expect(removeSessionWorkspace).toHaveBeenCalledOnce()
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Domovoi could not remove a failed fork worktree",
      detail: expect.stringContaining("cleanup race"),
    }))

    await expect(rpc("session.fork", forkParams)).resolves.toMatchObject({
      error: { code: -32603 },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("fork-provider-thread")
    expect(removeSessionWorkspace).toHaveBeenCalledTimes(2)
    const afterPersistenceFailure = (await rpc("workspace.get", {})).result as typeof snapshot
    expect(afterPersistenceFailure.activeSessionId).toBe(activeSelection)
    expect(afterPersistenceFailure.sessions.find((session) => session.id === source.id)).toEqual(sourceBefore)
    expect(afterPersistenceFailure.sessions.some(
      (session) => session.forkedFrom?.requestId === forkParams.requestId,
    )).toBe(false)

    const created = await rpc("session.fork", forkParams)
    const createdResult = created.result as typeof snapshot
    expect(createdResult.activeSessionId).toBe(activeSelection)
    expect(createdResult.sessions.find((session) => session.id === source.id)).toEqual(sourceBefore)
    const fork = createdResult.sessions.find((session) => session.forkedFrom?.requestId === forkParams.requestId)!
    expect(fork).toMatchObject({
      state: "idle",
      runtime,
      baseCommit: sourceCheckpoint.commit,
      providerThreadId: "fork-provider-thread",
      forkedFrom: {
        sourceSessionId: source.id,
        checkpointId: sourceCheckpoint.id,
        checkpointCommit: sourceCheckpoint.commit,
        requestId: forkParams.requestId,
        client: "desktop",
        requestedRuntime,
      },
    })
    expect(createdResult.thread.filter((item) => item.sessionId === fork.id)).toEqual([
      expect.objectContaining({ kind: "checkpoint", commit: sourceCheckpoint.commit }),
      expect.objectContaining({ kind: "system", body: expect.stringContaining("Forked from") }),
    ])
    expect(agent.stopThread).toHaveBeenCalledTimes(1)

    const replayed = await rpc("session.fork", forkParams)
    expect((replayed.result as typeof snapshot).sessions.filter(
      (session) => session.forkedFrom?.requestId === forkParams.requestId,
    )).toHaveLength(1)
    expect(createSessionWorkspaceFromCheckpoint).toHaveBeenCalledTimes(3)
    expect(agent.startThread).toHaveBeenCalledTimes(3)

    await expect(rpc("session.fork", {
      ...forkParams,
      runtime: { ...runtime, reasoning: "high" },
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Fork request ID conflicts with an existing fork" },
    })
    expect(createSessionWorkspaceFromCheckpoint).toHaveBeenCalledTimes(3)
    socket.close()
  })

  it("rejects checkpoint forks when the workspace service lacks fork support", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const source = snapshot.sessions[0]!
    source.state = "idle"
    source.workspacePath = "/worktrees/session-billing"
    delete source.activeTurnId
    const runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build" as const,
      auto: false,
    }
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "turn"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(), restore: vi.fn(),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "unsupported-fork-token",
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      agents: { codex: agent },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.fork",
      params: {
        sessionId: source.id,
        checkpointId: "thread-checkpoint",
        requestId: "fork-request-unsupported",
        runtime,
        client: "desktop",
      },
    }))
    await expect(response).resolves.toMatchObject({
      error: { code: -32602, message: "Checkpoint forks are not supported by this workspace" },
    })
    expect(agent.startThread).not.toHaveBeenCalled()
    socket.close()
  })

  it("serves agent-created HTML only from the active session worktree", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-artifact-"))
    scratchDirectories.push(scratch)
    const worktree = join(scratch, "worktree")
    await mkdir(worktree)
    await writeFile(join(worktree, "preview.html"), "<h1>Domovoi preview</h1>")
    await writeFile(join(worktree, "safe.html"), "<h1>Safe preview</h1>")
    await writeFile(join(scratch, "outside.html"), "<h1>Escaped preview</h1>")
    await symlink(join(worktree, "safe.html"), join(worktree, "linked.html"))

    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "provider-thread-preview"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-preview"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(async () => ({
        root: scratch,
        name: "domovoi",
        branch: "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async () => ({
        path: worktree,
        branch: "domovoi/preview",
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: [] })),
      restore: vi.fn(async () => ({
        restoredCommit: "b".repeat(40),
        recoveryCommit: "c".repeat(40),
      })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agent,
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await rpc("project.open", { path: scratch, client: "desktop" })
    const created = await rpc("session.create", {
      title: "Preview the plan",
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        permissionMode: "build",
        auto: false,
      },
      client: "desktop",
    })
    const sessionId = (created.result as { activeSessionId: string }).activeSessionId

    for (const listener of agentListeners) {
      listener({
        type: "item",
        phase: "completed",
        params: {
          threadId: "provider-thread-preview",
          item: {
            id: "file-change-preview",
            type: "fileChange",
            changes: [
              { path: "preview.html", kind: "update" },
              { path: "linked.html", kind: "update" },
              { path: join(scratch, "outside.html"), kind: "update" },
            ],
          },
        },
      })
    }

    const snapshot = await rpc("workspace.get", {})
    const artifact = (snapshot.result as {
      artifacts: Array<{ id: string; sessionId: string; type: string; revision: number; path?: string }>
    }).artifacts.find((candidate) => candidate.type === "preview")
    expect(artifact).toMatchObject({ sessionId, type: "preview", path: "preview.html" })
    expect((snapshot.result as { artifacts: unknown[] }).artifacts).toHaveLength(2)

    const accessResponse = await rpc("artifact.authorize", {
      sessionId,
      artifactId: artifact!.id,
      revision: artifact!.revision,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      client: "desktop",
    })
    const access = accessResponse.result as {
      sessionId: string
      artifactId: string
      revision: number
      purpose: string
      bridgeChannel: string
      expiresAt: number
      signature: string
    }
    expect(access).toMatchObject({
      artifactId: artifact!.id,
      bridgeChannel: "preview_channel_123456",
    })
    expect(access.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000))
    expect(access.signature).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await expect(rpc("artifact.authorize", {
      sessionId,
      artifactId: "missing-preview",
      revision: 1,
      purpose: "preview",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Preview artifact does not exist" },
    })

    const preview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}`,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'")
    await expect(preview.text()).resolves.toBe("<h1>Domovoi preview</h1>")

    const bridgedPreview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}?bridge=preview_channel_123456&parentOrigin=http%3A%2F%2F127.0.0.1%3A5178`,
    )
    const bridgedContent = await bridgedPreview.text()
    expect(bridgedContent).toContain("domovoi.preview.selection")
    expect(bridgedContent).toContain("preview_channel_123456")
    expect(bridgedContent).toContain(artifact!.id)

    const signedPreview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(access.artifactId)}?session=${access.sessionId}&revision=${access.revision}&purpose=${access.purpose}&bridge=${access.bridgeChannel}&parentOrigin=http%3A%2F%2F127.0.0.1%3A5178&expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(signedPreview.status).toBe(200)
    expect(await signedPreview.text()).toContain("domovoi.preview.selection")

    const printResponse = await rpc("artifact.authorize", {
      sessionId,
      artifactId: artifact!.id,
      revision: artifact!.revision,
      purpose: "print",
      client: "desktop",
    })
    const printAccess = printResponse.result as typeof access
    const printUrl = `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(printAccess.artifactId)}?session=${printAccess.sessionId}&revision=${printAccess.revision}&purpose=print&expires=${printAccess.expiresAt}&signature=${printAccess.signature}`
    const printable = await fetch(printUrl)
    expect(printable.status).toBe(200)
    expect(printable.headers.get("content-security-policy")).toContain("sandbox")
    expect(await printable.text()).toContain("External resources and active content were removed")
    expect((await fetch(printUrl.replace(printAccess.signature, access.signature))).status).toBe(404)

    const downloadResponse = await rpc("artifact.authorize", {
      sessionId,
      artifactId: artifact!.id,
      revision: artifact!.revision,
      purpose: "download",
      client: "desktop",
    })
    const downloadAccess = downloadResponse.result as typeof access
    const download = await fetch(`http://${address.host}:${address.port}/artifacts/${encodeURIComponent(downloadAccess.artifactId)}?session=${downloadAccess.sessionId}&revision=${downloadAccess.revision}&purpose=download&expires=${downloadAccess.expiresAt}&signature=${downloadAccess.signature}`)
    expect(download.headers.get("content-disposition")).toContain("attachment")

    await writeFile(join(worktree, "preview.html"), `<main>${"<div>".repeat(maximumPrintableArtifactDepth + 2)}Plan${"</div>".repeat(maximumPrintableArtifactDepth + 2)}</main>`)
    const limited = await fetch(printUrl)
    expect(limited.status).toBe(413)
    await expect(limited.json()).resolves.toEqual({ error: "artifact_limit" })
    await unlink(join(worktree, "preview.html"))
    const missing = await fetch(printUrl)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: "not_found" })
    await writeFile(join(worktree, "preview.html"), "<h1>Domovoi preview</h1>")

    await expect(rpc("artifact.authorize", { sessionId: "other-session", artifactId: artifact!.id, revision: artifact!.revision, purpose: "print", client: "desktop" })).resolves.toMatchObject({ error: { code: -32602 } })
    // The writes above can raise the artifact's revision before this point, so
    // the revision the daemon does not have is read now rather than assumed.
    const currentSnapshot = await rpc("workspace.get", {})
    const currentArtifact = (currentSnapshot.result as {
      artifacts: Array<{ id: string; revision: number }>
    }).artifacts.find((candidate) => candidate.id === artifact!.id)
    await expect(rpc("artifact.authorize", { sessionId, artifactId: artifact!.id, revision: currentArtifact!.revision + 1, purpose: "print", client: "desktop" })).resolves.toMatchObject({ error: { code: -32602 } })

    const invalidBridge = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}?bridge=short`,
    )
    await expect(invalidBridge.text()).resolves.toBe("<h1>Domovoi preview</h1>")

    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        host: address.host,
        port: address.port,
        path: `/artifacts/${encodeURIComponent(artifact!.id)}`,
        headers: { Host: "malicious.example" },
      }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.once("error", reject)
      request.end()
    })
    expect(rebindingStatus).toBe(404)

    const linkedArtifact = (snapshot.result as {
      artifacts: Array<{ id: string; title: string }>
    }).artifacts.find((candidate) => candidate.title === "linked.html")!
    await unlink(join(worktree, "linked.html"))
    await symlink(join(scratch, "outside.html"), join(worktree, "linked.html"))
    const symlinkEscape = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(linkedArtifact.id)}`,
    )
    expect(symlinkEscape.status).toBe(404)

    const escaped = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent("../preview")}`,
    )
    expect(escaped.status).toBe(404)
    socket.close()
  })

  it("rejects Build-auto before a turn when the provider cannot enforce it", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: true,
    }
    session.state = "idle"
    session.workspacePath = "/worktrees/build-auto"
    session.providerThreadId = "thread-build-auto"
    delete session.activeTurnId
    const agent = {
      permissionCapabilities: { ask: "read-only", buildAuto: "unsupported" },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-build-auto"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: {
        load: () => snapshot,
        save: vi.fn(),
        close: vi.fn(),
      },
      agents: { codex: agent },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.send",
      params: { sessionId: session.id, prompt: "Proceed", client: "desktop" },
    }))

    await expect(response).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Codex does not support enforceable Build auto",
      },
    })
    expect(agent.connect).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(agent.startTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it("rejects Ask before a turn when the provider cannot enforce read-only operation", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = {
      provider: "grok",
      model: "grok-code-fast-1",
      reasoning: "medium",
      permissionMode: "ask",
      auto: false,
    }
    session.state = "idle"
    session.workspacePath = "/worktrees/ask"
    session.providerThreadId = "thread-ask"
    delete session.activeTurnId
    const agent = {
      permissionCapabilities: { ask: "unsupported", buildAuto: "unsupported" },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => [{
        ...codexModels()[0]!,
        provider: "grok",
        id: "grok-code-fast-1",
      }]),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-ask"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: {
        load: () => snapshot,
        save: vi.fn(),
        close: vi.fn(),
      },
      agents: { grok: agent },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.send",
      params: { sessionId: session.id, prompt: "Inspect only", client: "desktop" },
    }))

    await expect(response).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "grok does not support enforceable Ask mode",
      },
    })
    expect(agent.connect).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(agent.startTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it.each([
    ["build", "ask"],
    ["ask", "build"],
  ] as const)("rejects an active %s to %s permission-boundary change, then allows it when idle", async (currentMode, nextMode) => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: currentMode,
      auto: false,
    }
    session.state = "active"
    session.workspacePath = "/worktrees/ask-boundary"
    session.providerThreadId = "thread-ask-boundary"
    session.activeTurnId = "turn-ask-boundary"
    const activateTurns = deferLiveTurns(snapshot)
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      permissionCapabilities: { ask: "read-only", buildAuto: "unsupported" },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      load: () => snapshot,
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: agent } })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    const nextRuntime = { ...session.runtime, permissionMode: nextMode }
    const savesBefore = store.save.mock.calls.length

    await expect(rpc("session.setRuntime", {
      sessionId: session.id,
      runtime: nextRuntime,
      client: "desktop",
    })).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Stop the active turn before entering or leaving Ask mode",
      },
    })
    expect(agent.connect).not.toHaveBeenCalled()
    expect(agent.listModels).not.toHaveBeenCalled()
    expect(agent.startThread).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(store.save).toHaveBeenCalledTimes(savesBefore)
    await expect(rpc("workspace.get", {})).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          activeTurnId: "turn-ask-boundary",
          runtime: expect.objectContaining({ permissionMode: currentMode }),
        })]),
      },
    })

    const safeMode = currentMode === "build" ? "plan" : "ask"
    await expect(rpc("session.setRuntime", {
      sessionId: session.id,
      runtime: { ...session.runtime, permissionMode: safeMode, reasoning: "high" },
      client: "desktop",
    })).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          activeTurnId: "turn-ask-boundary",
          runtime: expect.objectContaining({
            permissionMode: safeMode,
            reasoning: "high",
          }),
        })]),
      },
    })
    expect(agent.startThread).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(agent.startTurn).not.toHaveBeenCalled()
    expect(agent.steerTurn).not.toHaveBeenCalled()

    listener?.({
      type: "turn-completed",
      params: {
        threadId: "thread-ask-boundary",
        turnId: "turn-ask-boundary",
        turn: { id: "turn-ask-boundary", status: "completed" },
      },
    })
    await expect(rpc("session.setRuntime", {
      sessionId: session.id,
      runtime: nextRuntime,
      client: "desktop",
    })).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          runtime: expect.objectContaining({ permissionMode: nextMode }),
        })]),
      },
    })
    expect(agent.connect).toHaveBeenCalledOnce()
    expect(agent.listModels).toHaveBeenCalledOnce()
    expect(agent.startThread).not.toHaveBeenCalled()
    expect(agent.resumeThread).not.toHaveBeenCalled()
    socket.close()
  })

  it("auto-allows bounded work but keeps hard gates explicit", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = {
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
      permissionMode: "build",
      auto: true,
    }
    session.state = "idle"
    session.workspacePath = "/worktrees/build-auto"
    session.providerThreadId = "thread-build-auto"
    delete session.activeTurnId
    const skillInstallCommand = "/usr/bin/bash -lc 'pnpm dlx skills add getdomovoi/design-studio'"
    snapshot.approvalRules.push({
      id: "rule-skill-install",
      projectId: snapshot.project!.id,
      operation: "Install skill",
      command: skillInstallCommand,
      createdBy: "desktop",
      createdAt: new Date().toISOString(),
    })
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => [{
        ...codexModels()[0]!,
        provider: "claude-code",
        id: "sonnet",
      }]),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-build-auto"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      load: () => snapshot,
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { "claude-code": agent } })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    await rpc("session.send", {
      sessionId: session.id,
      prompt: "Prepare the release",
      client: "desktop",
    })
    listener!({
      type: "approval-requested",
      requestId: 11,
      threadId: session.providerThreadId,
      turnId: "turn-build-auto",
      command: "pnpm test",
    })
    listener!({
      type: "approval-requested",
      requestId: 12,
      threadId: session.providerThreadId,
      turnId: "turn-build-auto",
      reason: "Install skill",
      command: skillInstallCommand,
    })
    const current = await rpc("workspace.get", {})

    expect(agent.resolveApproval).toHaveBeenCalledWith(11, "allow-once")
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(12, expect.anything())
    expect(current).toMatchObject({
      result: {
        approvals: expect.arrayContaining([expect.objectContaining({
          providerRequestId: 12,
          command: skillInstallCommand,
          risk: "hard-gate",
        })]),
      },
    })
    const approvalId = (current.result as {
      approvals: Array<{ id: string; providerRequestId?: number }>
    }).approvals.find((approval) => approval.providerRequestId === 12)!.id
    const rejectedRule = await rpc("approval.resolve", {
      approvalId,
      decision: "always-project",
      client: "desktop",
    })
    expect(rejectedRule).toMatchObject({
      error: {
        code: -32602,
        message: "Hard-gate approvals cannot create standing rules",
      },
    })
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(12, expect.anything())
    const approved = await rpc("approval.resolve", {
      approvalId,
      decision: "allow-once",
      client: "desktop",
    })
    expect(agent.resolveApproval).toHaveBeenCalledWith(12, "allow-once")
    expect(approved).toMatchObject({
      result: {
        thread: expect.arrayContaining([expect.objectContaining({
          kind: "receipt",
          decision: "allow-once",
          operation: "Install skill",
          client: "desktop",
        })]),
      },
    })
    expect((approved.result as { approvals: Array<{ providerRequestId?: number }> }).approvals)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ providerRequestId: 12 })]))
    socket.close()
  })

  it("archives a session idempotently and retries partial cleanup after restart", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-billing"
    snapshot.sessions[1]!.workspacePath = "/worktrees/session-onboarding"
    const sessionWorkspacePath = session.workspacePath
    const otherWorkspacePath = snapshot.sessions[1]!.workspacePath
    snapshot.approvals = [
      { ...snapshot.approvals[0]!, id: "approval-billing", sessionId: session.id, providerRequestId: 11 },
      { ...snapshot.approvals[0]!, id: "approval-other", sessionId: snapshot.sessions[1]!.id, providerRequestId: 12 },
    ]
    const activateTurns = deferLiveTurns(snapshot)
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => { throw new Error("turn already completed") }),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      archiveSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: ["src/app.ts"] })),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const terminalProcesses = new Map<string, { kill: ReturnType<typeof vi.fn> }>()
    const terminalService = {
      spawn: vi.fn(({ cwd }: { cwd: string }) => {
        const process = {
          process: "/bin/sh", write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
          onData: vi.fn(() => ({ dispose: vi.fn() })),
          onExit: vi.fn(() => ({ dispose: vi.fn() })),
        }
        terminalProcesses.set(cwd, process)
        return process
      }),
    }
    const store = {
      snapshot,
      load() { return this.snapshot },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agent },
      workspaceService,
      terminalService,
      errorSink: vi.fn(),
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    const otherSession = store.snapshot.sessions[1]!
    await rpc("terminal.create", { terminalId: "billing-terminal", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "billing-client" })
    await rpc("terminal.create", { terminalId: "other-terminal", sessionId: otherSession.id, cols: 80, rows: 24, client: "desktop", clientId: "other-client" })
    listener!({
      type: "command-output",
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
      itemId: "archive-output",
      delta: "token=archive-buffer-secret",
    })

    const archived = await rpc("session.archive", { sessionId: session.id, client: "desktop" })
    expect(archived).toMatchObject({ result: { sessions: expect.arrayContaining([
      expect.objectContaining({ id: session.id, state: "archived", archiveCheckpoint: "d".repeat(40) }),
    ]) } })
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-billing", "turn-billing")
    expect(agent.stopThread).toHaveBeenCalledWith("thread-billing")
    expect(agent.resolveApproval).toHaveBeenCalledWith(11, "deny")
    expect(store.snapshot.approvals).toEqual([expect.objectContaining({ id: "approval-other" })])
    expect(terminalProcesses.get(sessionWorkspacePath)?.kill).toHaveBeenCalledOnce()
    expect(terminalProcesses.get(otherWorkspacePath)?.kill).not.toHaveBeenCalled()
    expect(workspaceService.checkpoint).toHaveBeenCalledWith(sessionWorkspacePath, "before session archive", expect.any(AbortSignal))
    expect(workspaceService.archiveSessionWorkspace).toHaveBeenCalledWith(sessionWorkspacePath, expect.any(AbortSignal))
    expect(store.snapshot.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-archive-output", output: "token=[REDACTED]" }),
    ]))
    expect(JSON.stringify(store.snapshot)).not.toContain("archive-buffer-secret")
    const durable = {
      thread: store.snapshot.thread.filter((item) => item.sessionId === session.id).length,
      artifacts: store.snapshot.artifacts.filter((item) => item.sessionId === session.id).length,
      annotations: store.snapshot.annotations.filter((item) => item.sessionId === session.id).length,
    }
    await rpc("session.archive", { sessionId: session.id, client: "web" })
    expect(agent.stopThread).toHaveBeenCalledOnce()
    expect(workspaceService.checkpoint).toHaveBeenCalledOnce()
    expect(workspaceService.archiveSessionWorkspace).toHaveBeenCalledOnce()
    expect(store.snapshot.thread.filter((item) => item.sessionId === session.id)).toHaveLength(durable.thread)
    expect(store.snapshot.artifacts.filter((item) => item.sessionId === session.id)).toHaveLength(durable.artifacts)
    expect(store.snapshot.annotations.filter((item) => item.sessionId === session.id)).toHaveLength(durable.annotations)
    const artifact = store.snapshot.artifacts.find((item) => item.sessionId === session.id)!
    const annotation = store.snapshot.annotations.find((item) => item.sessionId === session.id)!
    for (const [method, params] of [
      ["session.send", { sessionId: session.id, prompt: "resume", client: "web" }],
      ["checkpoint.create", { sessionId: session.id, client: "web" }],
      ["terminal.create", { terminalId: "archived-terminal", sessionId: session.id, cols: 80, rows: 24, client: "web", clientId: "archived-client" }],
      ["annotation.create", { sessionId: session.id, artifactId: artifact.id, anchor: { textQuote: "archived" }, body: "mutate", client: "web" }],
      ["annotation.reply", { annotationId: annotation.id, body: "mutate", client: "web" }],
      ["annotation.setStatus", { annotationId: annotation.id, status: "resolved", client: "web" }],
    ] as const) await expect(rpc(method, params)).resolves.toMatchObject({ error: { code: -32602 } })
    await expect(rpc("session.activate", { sessionId: session.id, client: "web" })).resolves.toMatchObject({
      result: { activeSessionId: session.id },
    })
    await expect(rpc("session.history", { sessionId: session.id, limit: 50 })).resolves.toHaveProperty("result")
    socket.close()

    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    store.snapshot.sessions[0]!.state = "archiving"
    store.snapshot.sessions[0]!.workspacePath = sessionWorkspacePath
    store.snapshot.sessions[0]!.providerThreadId = "thread-recovery"
    delete store.snapshot.sessions[0]!.archiveCheckpoint
    delete store.snapshot.sessions[0]!.archivedAt
    workspaceService.archiveSessionWorkspace.mockRejectedValueOnce(new Error("busy worktree"))
    agent.resumeThread.mockClear()
    const errors: Array<{ context: string; detail: string }> = []
    const failedRecovery = new DomovoiDaemon({ port: 0, store, agents: { codex: agent }, workspaceService, errorSink: (entry) => errors.push(entry) })
    running.push(failedRecovery)
    await expect(failedRecovery.start()).resolves.toEqual(expect.objectContaining({ port: expect.any(Number) }))
    expect(store.snapshot.sessions[0]).toMatchObject({ state: "archiving", workspacePath: sessionWorkspacePath })
    expect(store.snapshot.sessions[0]).not.toHaveProperty("providerThreadId")
    expect(agent.resumeThread).toHaveBeenCalledWith({
      threadId: "thread-recovery",
      cwd: sessionWorkspacePath,
      runtime: store.snapshot.sessions[0]!.runtime,
    })
    expect(agent.resumeThread.mock.invocationCallOrder[0]).toBeLessThan(
      agent.stopThread.mock.invocationCallOrder.at(-1)!,
    )
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({
      detail: expect.stringContaining("busy worktree"),
    })]))
    await failedRecovery.stop()
    running.splice(running.indexOf(failedRecovery), 1)
    const recovered = new DomovoiDaemon({ port: 0, store, agents: { codex: agent }, workspaceService })
    running.push(recovered)
    await recovered.start()
    expect(store.snapshot.sessions[0]).toMatchObject({ state: "archived", archiveCheckpoint: "d".repeat(40) })
    expect(store.snapshot.sessions[0]).not.toHaveProperty("workspacePath")
    expect(agent.stopThread).toHaveBeenCalledTimes(2)
  })

  it("ignores provider events after archive intent survives cleanup failure", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-billing"
    snapshot.approvals = [
      {
        ...snapshot.approvals[0]!,
        id: "approval-billing",
        sessionId: session.id,
        providerRequestId: 11,
      },
      {
        ...snapshot.approvals[0]!,
        id: "approval-billing-second",
        sessionId: session.id,
        providerRequestId: 13,
      },
    ]
    const activateTurns = deferLiveTurns(snapshot)
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => { throw new Error("provider stop failed") }), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn((requestId: number) => {
        if (requestId === 11) throw new Error("provider denial failed")
      }),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      archiveSessionWorkspace: vi.fn(async () => {}), checkpoint: vi.fn(), restore: vi.fn(),
    } satisfies WorkspaceService
    const store = {
      snapshot,
      load() { return this.snapshot },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const errors: Array<{ context: string; detail: string }> = []
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agent },
      workspaceService,
      errorSink: (entry) => errors.push(entry),
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    await expect(rpc("session.archive", { sessionId: session.id, client: "desktop" }))
      .resolves.toMatchObject({ error: { code: -32603 } })
    expect(agent.resolveApproval).toHaveBeenCalledWith(11, "deny")
    expect(agent.resolveApproval).toHaveBeenCalledWith(13, "deny")
    expect(agent.stopThread).toHaveBeenCalledWith("thread-billing")
    expect(store.snapshot.approvals).toEqual([
      expect.objectContaining({ id: "approval-billing" }),
    ])
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("provider denial failed") }),
      expect.objectContaining({ detail: expect.stringContaining("provider stop failed") }),
    ]))
    const before = (await rpc("workspace.get", {})).result
    expect(before).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: session.id, state: "archiving" }),
      ]),
    })
    const annotation = snapshot.annotations.find((item) => item.sessionId === session.id)!
    const artifact = snapshot.artifacts.find((item) => item.sessionId === session.id)!
    for (const [method, params] of [
      ["approval.resolve", { approvalId: "approval-billing", decision: "deny", client: "web" }],
      ["session.setRuntime", { sessionId: session.id, runtime: session.runtime, client: "web" }],
      ["session.pause", { sessionId: session.id, client: "web" }],
      ["annotation.create", { sessionId: session.id, artifactId: artifact.id, anchor: { textQuote: "archiving" }, body: "mutate", client: "web" }],
      ["annotation.reply", { annotationId: annotation.id, body: "mutate", client: "web" }],
      ["annotation.setStatus", { annotationId: annotation.id, status: "resolved", client: "web" }],
    ] as const) {
      await expect(rpc(method, params)).resolves.toMatchObject({ error: { code: -32602 } })
    }
    listener!({
      type: "text-delta",
      threadId: "thread-billing",
      turnId: "turn-billing",
      delta: "must not enter archived history",
    })
    const after = (await rpc("workspace.get", {})).result

    expect(after).toEqual(before)
    socket.close()
  })

  it("rejects an invalid base commit as an archive checkpoint fallback", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "archiving"
    session.archiveRequestedAt = "2026-08-29T12:00:00.000Z"
    session.baseCommit = "not-a-commit"
    delete session.workspacePath
    delete session.providerThreadId
    delete session.activeTurnId
    snapshot.thread = snapshot.thread.filter(
      (item) => item.sessionId !== session.id || item.kind !== "checkpoint",
    )
    snapshot.approvals = snapshot.approvals.filter(
      (approval) => approval.sessionId !== session.id,
    )
    const store = {
      snapshot: structuredClone(snapshot),
      load() { return structuredClone(this.snapshot) },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const errors: Array<{ context: string; detail: string }> = []
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agent },
      errorSink: (entry) => errors.push(entry),
    })
    running.push(daemon)

    await expect(daemon.start()).resolves.toEqual(expect.objectContaining({
      port: expect.any(Number),
    }))
    expect(store.snapshot.sessions[0]).toMatchObject({ state: "archiving" })
    expect(store.snapshot.sessions[0]).not.toHaveProperty("archiveCheckpoint")
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("no durable checkpoint") }),
    ]))
  })

  it("broadcasts archiving intent before provider cleanup completes", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "thread-billing"
    delete session.activeTurnId
    snapshot.approvals = []
    let releaseStop: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve })
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(() => stopped), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      archiveSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "f".repeat(40), changedFiles: [] })),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agents: { codex: agent },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const changes: Record<string, unknown>[] = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        method?: string
        params?: { sessions?: Array<{ id: string; state: string }> }
      }
      if (message.method === "workspace.changed") changes.push(message as Record<string, unknown>)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.archive",
      params: { sessionId: session.id, client: "desktop" },
    }))

    try {
      await vi.waitFor(() => expect(agent.stopThread).toHaveBeenCalledWith("thread-billing"))
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "workspace.changed",
          params: expect.objectContaining({
            sessions: expect.arrayContaining([
              expect.objectContaining({ id: session.id, state: "archiving" }),
            ]),
          }),
        }),
      ]))
    } finally {
      releaseStop!()
    }
    await expect(response).resolves.toHaveProperty("result")
    socket.close()
  })

  it("serves attributed redacted audit records for authenticated RPC outcomes", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.workspacePath = "/worktrees/audit-test"
    session.providerThreadId = "audit-thread"
    delete session.activeTurnId
    const artifact = snapshot.artifacts.find((candidate) => candidate.sessionId === session.id)!
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      archiveSessionWorkspace: vi.fn(), restore: vi.fn(),
      checkpoint: vi.fn((_path: string, _label: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })),
    } satisfies WorkspaceService
    let providerEvent: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        providerEvent = listener
        return () => { providerEvent = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      workspaceService,
      agents: { "claude-code": agent },
      agentTimeoutMs: 5,
    })
    running.push(daemon)
    const address = await daemon.start()
    const intruder = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      intruder.once("open", resolve)
      intruder.once("error", reject)
    })
    const deniedResponse = new Promise<Record<string, unknown>>((resolve) => {
      intruder.once("message", (data) => resolve(JSON.parse(data.toString())))
    })
    intruder.send(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "workspace.get", params: {} }))
    await expect(deniedResponse).resolves.toMatchObject({ error: { code: -32_001 } })
    intruder.close()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: object) => new Promise<TestRpcResponse<M>>((resolve) => {
      id += 1
      const requestId = id
      const listener = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== requestId) return
        socket.off("message", listener)
        resolve(message as TestRpcResponse<M>)
      }
      socket.on("message", listener)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })

    await expect(rpc("system.hello", {
      client: "web",
      clientId: "browser-audit-test",
      clientVersion: "audit-test",
      authToken: daemon.authToken,
    })).resolves.toHaveProperty("result")

    await expect(rpc("annotation.create", {
      sessionId: session.id,
      artifactId: artifact.id,
      anchor: { textQuote: "plan" },
      body: "Authorization: Bearer must-never-persist",
      client: "phone",
    })).resolves.toHaveProperty("result")
    await expect(rpc("annotation.create", {
      sessionId: session.id,
      artifactId: "missing-artifact",
      anchor: { textQuote: "plan" },
      body: "api_key=must-never-persist-either",
      client: "desktop",
    })).resolves.toMatchObject({ error: { code: -32602 } })
    await expect(rpc("checkpoint.create", {
      sessionId: session.id,
      label: "audit timeout",
      client: "desktop",
    })).resolves.toMatchObject({ error: { code: -32603, message: "Checkpoint timed out" } })
    providerEvent!({
      type: "approval-requested",
      requestId: 44,
      threadId: "audit-thread",
      itemId: "provider-item-44",
      command: "deploy --token provider-command-secret",
      reason: "Authorization: Bearer provider-reason-secret",
    })
    providerEvent!({
      type: "item",
      phase: "completed",
      params: {
        threadId: "audit-thread",
        item: {
          id: "provider-tool-1",
          type: "commandExecution",
          status: "completed",
          command: ["echo", "provider-payload-secret"],
          aggregatedOutput: "provider-output-secret",
        },
      },
    })
    await rpc("workspace.get", {})
    const queried = await rpc("audit.query", {
      action: "annotation.create",
      sessionId: session.id,
      projectId: snapshot.project!.id,
      limit: 10,
    })
    expect(queried.result).toMatchObject({
      hasMore: false,
      entries: [
        expect.objectContaining({ outcome: "failed" }),
        expect.objectContaining({
          actor: { kind: "client", client: "web", clientId: "browser-audit-test" },
          action: "annotation.create",
          outcome: "succeeded",
          sessionId: session.id,
          projectId: snapshot.project!.id,
          target: artifact.id,
        }),
      ],
    })
    const cancelled = await rpc("audit.query", { action: "checkpoint.create", limit: 10 })
    expect(cancelled.result.entries).toEqual([
      expect.objectContaining({ outcome: "cancelled", sessionId: session.id }),
    ])
    const denied = await rpc("audit.query", { action: "security.authentication", limit: 10 })
    expect(denied.result.entries).toEqual([
      expect.objectContaining({ outcome: "denied", actor: { kind: "daemon", component: "authentication" } }),
    ])
    await expect(rpc("audit.query", { before: "audit-does-not-exist", limit: 10 }))
      .resolves.toMatchObject({ error: { code: -32602, message: "Audit cursor does not exist" } })
    const providerTools = await rpc("audit.query", { action: "provider.tool.completed", limit: 10 })
    expect(providerTools.result.entries).toEqual([
      expect.objectContaining({
        actor: { kind: "provider", provider: "claude-code", providerThreadId: "audit-thread" },
        outcome: "succeeded",
        sessionId: session.id,
        target: "provider-tool-1",
      }),
    ])
    const exported = await rpc("audit.export", { limit: 100 })
    expect(exported.result.content).not.toContain("must-never-persist")
    expect(exported.result.content).not.toContain("must-never-persist-either")
    expect(exported.result.content).not.toContain("provider-command-secret")
    expect(exported.result.content).not.toContain("provider-reason-secret")
    expect(exported.result.content).not.toContain("provider-payload-secret")
    expect(exported.result.content).not.toContain("provider-output-secret")
    expect(exported.result.content).toContain("annotation.create")
    expect(exported.result.content).not.toContain('"action":"audit.query"')
    socket.close()
  })

  it("cancels overdue audit exports and rejects duplicate in-flight request ids", async () => {
    const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
      id: `audit-test-${append.mock.calls.length}`,
      occurredAt: "2026-08-29T12:00:00.000Z",
      ...input,
    }))
    const auditLog = {
      append,
      query: vi.fn(() => ({ entries: [], hasMore: false })),
      export: vi.fn((_params, signal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })),
    } satisfies AuditLog
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      auditLog,
      agentTimeoutMs: 5,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const responses = new Promise<Array<Record<string, unknown>>>((resolve) => {
      const collected: Array<Record<string, unknown>> = []
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== 88) return
        collected.push(message)
        if (collected.length === 2) resolve(collected)
      })
    })
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 88,
      method: "audit.export",
      params: { limit: 10 },
    })
    socket.send(request)
    socket.send(request)

    await expect(responses).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ error: { code: -32600, message: "Request id is already in flight" } }),
      expect.objectContaining({ error: { code: -32603, message: "Audit export timed out" } }),
    ]))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "security.duplicate-request-id",
      outcome: "denied",
    }))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      action: "audit.export",
      outcome: "cancelled",
    }))
    socket.close()
  })

  it("bounds unauthenticated audit writes across reconnects", async () => {
    const append = vi.fn((input: Parameters<AuditLog["append"]>[0]) => ({
      id: `audit-pre-auth-${append.mock.calls.length}`,
      occurredAt: "2026-08-29T12:00:00.000Z",
      ...input,
    }))
    const auditLog = {
      append,
      query: vi.fn(() => ({ entries: [], hasMore: false })),
      export: vi.fn(() => ({
        format: "jsonl" as const,
        exportedAt: "2026-08-29T12:00:00.000Z",
        entryCount: 0,
        content: "",
        hasMore: false,
      })),
    } satisfies AuditLog
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", auditLog })
    running.push(daemon)
    const address = await daemon.start()

    for (let connection = 0; connection < 2; connection += 1) {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      const replies = new Promise<void>((resolve) => {
        let count = 0
        socket.on("message", () => {
          count += 1
          if (count === 20) resolve()
        })
      })
      for (let request = 0; request < 20; request += 1) socket.send("not-json")
      await replies
      socket.close()
    }

    expect(append.mock.calls.filter(([entry]) => entry.action === "security.invalid-request"))
      .toHaveLength(1)
  })
})

describe("adversarially deep JSON-RPC payloads", () => {
  it("answers deeply nested requests with a bounded error and keeps serving", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const rejections: unknown[] = []
    const recordRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", recordRejection)
    try {
      const nested = `${"[".repeat(100_000)}1${"]".repeat(100_000)}`
      const rejected = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
      })
      socket.send(`{"jsonrpc":"2.0","id":1,"method":"workspace.get","params":{"nested":${nested}}}`)
      await expect(rejected).resolves.toMatchObject({
        error: { code: -32600, message: "Request does not match JSON-RPC 2.0" },
      })

      const served = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace.get", params: {} }))
      await expect(served).resolves.toMatchObject({ id: 2 })
      await new Promise((resolve) => setImmediate(resolve))
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", recordRejection)
      socket.close()
    }
  })
})

describe("DomovoiDaemon transfers", () => {
  const running: DomovoiDaemon[] = []

  function stubWorkspaceService() {
    return {
      inspect: async () => ({ root: "/repo", name: "repo", branch: "main", head: "a".repeat(40) }),
      createSessionWorkspace: async (_repository: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      }),
      removeSessionWorkspace: async () => {},
      checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
      restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
      restoreSessionFromBundle: async (_bundlePath: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "c".repeat(40),
      }),
    }
  }

  function rpcCaller(socket: WebSocket) {
    let id = 0
    return (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }
  }

  afterEach(async () => {
    await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  })

  function bundleBytes() {
    return Buffer.from("PACK a session worktree")
  }

  it("restores a session streamed from another machine", async () => {
    const bytes = bundleBytes()
    const restored: { bundlePath: string; sessionId: string }[] = []
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      workspaceService: {
        ...stubWorkspaceService(),
        restoreSessionFromBundle: async (bundlePath: string, sessionId: string) => {
          restored.push({ bundlePath, sessionId })
          return {
            path: `/worktrees/${sessionId}`,
            branch: `domovoi/${sessionId}`,
            baseCommit: "c".repeat(40),
          }
        },
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const call = rpcCaller(socket)

    const begun = await call("transfer.begin", {
      sessionId: "session-1",
      sourceMachineId: `machine-${"a".repeat(32)}`,
      method: "git-bundle",
      digest: createHash("sha256").update(bytes).digest("hex"),
      totalBytes: bytes.length,
      client: "desktop",
    })
    const transferId = (begun.result as { transferId: string }).transferId
    const finished = await call("transfer.chunk", {
      transferId,
      sequence: 0,
      bytes: bytes.toString("base64"),
      final: true,
      client: "desktop",
    })

    expect(finished.result).toMatchObject({
      state: "restored",
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
    })
    expect(restored).toHaveLength(1)
    socket.close()
  })

  it("reports a refusal instead of restoring bytes it cannot verify", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      workspaceService: {
        ...stubWorkspaceService(),
        restoreSessionFromBundle: async () => {
          throw new Error("restore must not run")
        },
      },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)
    const call = rpcCaller(socket)

    const begun = await call("transfer.begin", {
      sessionId: "session-1",
      sourceMachineId: `machine-${"a".repeat(32)}`,
      method: "git-bundle",
      digest: createHash("sha256").update("something else").digest("hex"),
      totalBytes: 32,
      client: "desktop",
    })
    const transferId = (begun.result as { transferId: string }).transferId
    const finished = await call("transfer.chunk", {
      transferId,
      sequence: 0,
      bytes: bundleBytes().toString("base64"),
      final: true,
      client: "desktop",
    })

    expect(finished.result).toEqual({ state: "refused", reason: "digest-mismatch" })
    socket.close()
  })

  it("frees a transfer slot when the client that opened it goes away", { timeout: 15_000 }, async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      workspaceService: stubWorkspaceService(),
    })
    running.push(daemon)
    const address = await daemon.start()

    const begin = async () => {
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      await identifyClient(socket)
      const answer = await rpcCaller(socket)("transfer.begin", {
        sessionId: "session-1",
        sourceMachineId: `machine-${"a".repeat(32)}`,
        method: "git-bundle",
        digest: "d".repeat(64),
        totalBytes: 32,
        client: "desktop",
      })
      return { socket, answer }
    }

    // Fill every slot from clients that then disappear without sending a byte.
    const abandoned = []
    for (let index = 0; index < maximumIncomingTransfers; index += 1) {
      abandoned.push(await begin())
    }
    for (const { socket } of abandoned) {
      socket.close()
      await new Promise<void>((resolve) => socket.once("close", () => resolve()))
    }

    // The daemon sees the close a moment after the client does, so this waits
    // for the slot to come back rather than assuming it already has.
    const reopened = await vi.waitFor(async () => {
      const attempt = await begin()
      if (!attempt.answer.result) {
        attempt.socket.close()
        throw new Error(`transfer slots are still held: ${JSON.stringify(attempt.answer.error)}`)
      }
      return attempt
    }, { timeout: 3_000, interval: 50 })

    expect(reopened.answer.result).toMatchObject({ transferId: expect.any(String) })
    reopened.socket.close()
  })

  it("refuses a transfer from a client holding only a device credential", async () => {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({ port: 0, store, authToken: "correct-horse-battery-staple" })
    running.push(daemon)
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const call = rpcCaller(socket)

    const refusal = await call("transfer.begin", {
      sessionId: "session-1",
      sourceMachineId: `machine-${"a".repeat(32)}`,
      method: "git-bundle",
      digest: "d".repeat(64),
      totalBytes: 32,
      client: "desktop",
    })

    expect(refusal).toMatchObject({
      error: { message: "Accepting a session transfer requires the daemon credential" },
    })
    socket.close()
  })
})

describe("DomovoiDaemon session transfer requests", () => {
  const running: DomovoiDaemon[] = []

  function stubWorkspaceService() {
    return {
      inspect: async () => ({ root: "/repo", name: "repo", branch: "main", head: "a".repeat(40) }),
      createSessionWorkspace: async (_repository: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      }),
      removeSessionWorkspace: async () => {},
      checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
      restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
      restoreSessionFromBundle: async (_bundlePath: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "c".repeat(40),
      }),
    }
  }


  function rpcCaller(socket: WebSocket) {
    let id = 0
    return (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }
  }


  afterEach(async () => {
    await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  })

  function transferDaemon(options: {
    connectToMachine?: (machineId: string) => Promise<{
      call: (method: string, params: Record<string, unknown>) => Promise<unknown>
      close: () => void
    }>
  } = {}) {
    const store = new SqliteWorkspaceStore(":memory:", demoWorkspace)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      workspaceService: {
        inspect: async () => ({ root: "/repo", name: "repo", branch: "main", head: "a".repeat(40) }),
        createSessionWorkspace: async (_repository: string, sessionId: string) => ({
          path: `/worktrees/${sessionId}`,
          branch: `domovoi/${sessionId}`,
          baseCommit: "a".repeat(40),
        }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
        restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
        bundleSession: async (_worktree: string, bundlePath: string) => ({
          path: bundlePath,
          commit: "b".repeat(40),
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK bundle"),
      ...(options.connectToMachine ? { connectToMachine: options.connectToMachine } : {}),
    })
    running.push(daemon)
    return { daemon, store }
  }

  it("moves a session to another daemon with no dialer supplied", async () => {
    const targetMachineId = `machine-${"e".repeat(32)}`
    const targetSecret = "target-horse-battery-staple"
    const restored: string[] = []
    const target = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: targetSecret,
      workspaceService: {
        ...stubWorkspaceService(),
        restoreSessionFromBundle: async (_bundlePath: string, sessionId: string) => {
          restored.push(sessionId)
          return {
            path: `/worktrees/${sessionId}`,
            branch: `domovoi/${sessionId}`,
            baseCommit: "f".repeat(40),
          }
        },
      },
    })
    running.push(target)
    const targetAddress = await target.start()

    // A session only moves when it has a worktree to move.
    const snapshot = structuredClone(demoWorkspace)
    const moved = snapshot.sessions.find((candidate) => candidate.state === "idle")!
    moved.workspacePath = "/worktrees/session-audit"
    // The machine id must be one the transfer protocol accepts, and the
    // project belongs to that machine.
    snapshot.machine.id = `machine-${"a".repeat(32)}`
    if (snapshot.project) snapshot.project.machineId = snapshot.machine.id
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    const credentials = new Map<string, string>([[targetMachineId, targetSecret]])
    const source = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
      machineCredentials: {
        save: (id: string, credential: string) => credentials.set(id, credential),
        forMachine: (id: string) => credentials.get(id),
        forget: (id: string) => credentials.delete(id),
        machines: () => [...credentials.keys()],
      },
      workspaceService: {
        ...stubWorkspaceService(),
        bundleSession: async (_worktree: string, bundlePath: string) => ({
          path: bundlePath,
          commit: "b".repeat(40),
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK a session worktree"),
    })
    running.push(source)
    // The target is reachable on this machine, which is the only way plaintext
    // is allowed to carry a credential.
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion: "0.1.0",
      transports: [{
        kind: "local",
        endpoint: `ws://127.0.0.1:${targetAddress.port}/rpc`,
        authenticated: true,
      }],
    }, Date.now())
    const sourceAddress = await source.start()
    const socket = authenticatedSocket(source, `ws://${sourceAddress.host}:${sourceAddress.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)

    const answer = await rpcCaller(socket)("session.transfer", {
      sessionId: moved.id,
      targetMachineId,
      client: "desktop",
    })

    expect(answer).toMatchObject({
      result: { outcome: "succeeded", workspacePath: `/worktrees/${moved.id}` },
    })
    expect(restored).toEqual([moved.id])
    socket.close()
  }, 30_000)

  it("refuses to move a session to a machine the fleet does not know", async () => {
    const { daemon } = transferDaemon()
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)

    const answer = await rpcCaller(socket)("session.transfer", {
      sessionId: demoWorkspace.sessions[0]!.id,
      targetMachineId: `machine-${"f".repeat(32)}`,
      client: "desktop",
    })

    expect(answer.result).toEqual({ outcome: "refused", reason: "target-unreachable" })
    socket.close()
  })

  it("does not reach for a machine before the transfer is allowed", async () => {
    let dialed = 0
    const targetMachineId = `machine-${"b".repeat(32)}`
    const { daemon, store } = transferDaemon({
      connectToMachine: async () => {
        dialed += 1
        return { call: async () => ({}), close: () => {} }
      },
    })
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "tailnet",
      capabilities: ["sessions"],
      protocolVersion: "0.1.0",
      transports: [
        { kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true },
      ],
    }, Date.now())
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)

    // The target is known and healthy; the session is the problem, and that
    // has to be settled before anything reaches for the other machine.
    const answer = await rpcCaller(socket)("session.transfer", {
      sessionId: demoWorkspace.sessions.find((candidate) => candidate.state === "active")!.id,
      targetMachineId: targetMachineId,
      client: "desktop",
    })

    expect(answer).toMatchObject({ result: { outcome: "refused", reason: "session-turn-active" } })
    expect(dialed).toBe(0)
    socket.close()
  })

  it("refuses a transfer from a client holding only a device credential", async () => {
    const { daemon, store } = transferDaemon()
    const address = await daemon.start()
    const issued = store.devices.pair({ label: "studio-ipad" })
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const answer = await rpcCaller(socket)("session.transfer", {
      sessionId: demoWorkspace.sessions[0]!.id,
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
    })

    expect(answer).toMatchObject({
      error: { message: "Moving a session requires the daemon credential" },
    })
    socket.close()
  })

  it("refuses to move a session this machine does not have", async () => {
    const { daemon } = transferDaemon()
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await identifyClient(socket)

    const answer = await rpcCaller(socket)("session.transfer", {
      sessionId: "session-does-not-exist",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
    })

    expect(answer).toMatchObject({ error: { message: "Session does not exist" } })
    socket.close()
  })
})
