import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumWorkspaceDeltaChunkLength,
  type ProviderModel,
} from "@getdomovoi/protocol"

import {
  appendPlanDelta,
  artifactAccessMatches,
  canServeArtifacts,
  frameAncestorsFor,
  DomovoiDaemon,
  hostAuthorityMatches,
  isTestCommandTitle,
  sessionHistoryEntries,
  sessionHistoryPage,
  signArtifactAccess,
  workspaceSnapshotForClient,
  workspaceDeltaChunks,
} from "./server.js"
import type { AgentAdapter, AgentEvent } from "./codex.js"
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import type { SkillCatalog } from "./skills.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []

function authenticatedSocket(daemon: DomovoiDaemon, url: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
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
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("DomovoiDaemon", () => {
  it("drains queued events once and rejects late shutdown events", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-shutdown"
    session.activeTurnId = "turn-shutdown"
    const saves: typeof snapshot[] = []
    const order: string[] = []
    const store: WorkspaceStore = {
      load: () => structuredClone(snapshot),
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
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-restart"
    session.activeTurnId = "turn-restart"
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
    const daemon = new DomovoiDaemon({
      port: 0,
      authToken: "restart-token",
      statePath,
      store: new SqliteWorkspaceStore(statePath, snapshot),
      agent,
    })
    await daemon.start()

    listener!({
      type: "text-delta",
      threadId: "thread-restart",
      turnId: "turn-restart",
      delta: "persist me before close",
    })
    await daemon.stop()

    const recoveredStore = new SqliteWorkspaceStore(statePath, demoWorkspace)
    const recovered = recoveredStore.load()
    recoveredStore.close()
    expect(recovered.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", body: "persist me before close" }),
    ]))
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
    snapshot.thread = Array.from({ length: 105 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString(),
    }))

    const clientSnapshot = workspaceSnapshotForClient(snapshot)

    expect(clientSnapshot.thread).toHaveLength(100)
    expect(clientSnapshot.thread[0]?.id).toBe("message-5")
    expect(snapshot.thread).toHaveLength(105)
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
    const signature = signArtifactAccess(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
    )
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(true)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-2",
      "preview_channel_123456",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_changed",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
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
      artifactId: artifact.id,
      client: "web",
    })
    const access = accessResponse.result as { expiresAt: number; signature: string }
    const baseUrl = `http://${address.host}:${address.port}/artifacts/${artifact.id}`

    expect((await fetch(baseUrl)).status).toBe(404)
    const authorized = await fetch(
      `${baseUrl}?expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(authorized.status).toBe(200)
    await expect(authorized.text()).resolves.toBe("<h1>Remote preview</h1>")
    expect((await fetch(
      `${baseUrl}?expires=${access.expiresAt}&signature=${"x".repeat(43)}`,
    )).status).toBe(404)
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
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      agentTimeoutMs: 10,
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
    const responsiveness = await Promise.race([
      unrelated.then(() => "responsive" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    expect(agent.steerTurn).not.toHaveBeenCalled()
    releaseFirstTurn!("turn-first")
    await Promise.all([firstTurn, queuedSameSession, unrelated])

    expect(responsiveness).toBe("responsive")
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
      }]),
      read: vi.fn(async (id: string) => ({
        skill: {
          id,
          name: "repo-audit",
          description: "Audit a repository and render a ranked report.",
          path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
          scope: "user" as const,
          source: "agents" as const,
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
    socket.close()
  })

  it("publishes provider readiness discovered on the execution machine", async () => {
    const providerProbe = {
      inspect: vi.fn(async () => [
        { id: "claude-code", command: "claude", status: "ready" as const, version: "2.1.247" },
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
            { id: "opencode", command: "opencode", status: "missing", sessionCapable: true },
          ],
        },
      },
    })
    socket.close()
  })

  it("records a project-scoped rule for standing approval", async () => {
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
            operation: "Apply a production database migration",
            command: "pnpm prisma migrate deploy",
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
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
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
    })

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
    }))
    expect(agent.startTurn.mock.calls[0]![0].prompt).not.toContain("annotation-replay-copy")
    socket.close()
  })

  it("shares slow agent initialization across timed-out model requests", async () => {
    let finishConnect: (() => void) | undefined
    let finishModels: (() => void) | undefined
    const models = codexModels()
    const agent = {
      connect: vi.fn(() => new Promise<void>((resolve) => { finishConnect = resolve })),
      listModels: vi.fn(() => new Promise<typeof models>((resolve) => {
        finishModels = () => resolve(models)
      })),
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
      agentTimeoutMs: 500,
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
    const second = rpc(2)
    expect(agent.connect).toHaveBeenCalledOnce()
    finishConnect!()
    await vi.waitFor(
      () => expect(agent.listModels).toHaveBeenCalledOnce(),
      { interval: 1, timeout: 100 },
    )
    const third = rpc(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agent.listModels).toHaveBeenCalledOnce()
    finishModels!()
    await expect(second).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    await expect(third).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
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
      inspect: vi.fn(async (_path: string, _signal?: AbortSignal) => ({
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
    const reopening = rpc("project.open", { path: "/code/domovoi", client: "desktop" })
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
    expect(reopened).toMatchObject({ result: { activeSessionId: null, sessions: [] } })
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
      artifacts: Array<{ id: string; sessionId: string; type: string }>
    }).artifacts.find((candidate) => candidate.type === "preview")
    expect(artifact).toMatchObject({ sessionId, type: "preview" })
    expect((snapshot.result as { artifacts: unknown[] }).artifacts).toHaveLength(2)

    const accessResponse = await rpc("artifact.authorize", {
      artifactId: artifact!.id,
      bridgeChannel: "preview_channel_123456",
      client: "desktop",
    })
    const access = accessResponse.result as {
      artifactId: string
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
      artifactId: "missing-preview",
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
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(access.artifactId)}?bridge=${access.bridgeChannel}&parentOrigin=http%3A%2F%2F127.0.0.1%3A5178&expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(signedPreview.status).toBe(200)
    expect(await signedPreview.text()).toContain("domovoi.preview.selection")

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
})
