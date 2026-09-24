import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const models = [{
  provider: "codex" as const,
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "Coding model",
  supportedReasoningEfforts: ["none", "medium", "high", "xhigh", "max"],
  defaultReasoningEffort: "xhigh",
  isDefault: true,
}]

function agentWith(listeners: Set<(event: AgentEvent) => void>, threads: string[]) {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => models),
    startThread: vi.fn(async () => threads.shift() ?? "unused-thread"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-streaming"),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
}

// Mirrors the persistence worker: a write captures its snapshot when posted
// and reaches disk when the worker finishes, which may be after later writes.
function parkingStore(snapshot: WorkspaceSnapshot) {
  const disk: WorkspaceSnapshot[] = []
  let parkNext = false
  let parked = () => {}
  let release = () => {}
  const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
  const store = {
    load: () => structuredClone(snapshot),
    save: vi.fn((next: WorkspaceSnapshot) => { disk.push(structuredClone(next)) }),
    saveAsync: vi.fn(async (next: WorkspaceSnapshot) => {
      const posted = structuredClone(next)
      if (parkNext) {
        parkNext = false
        await new Promise<void>((resolve) => {
          release = resolve
          parked()
        })
      }
      disk.push(posted)
    }),
    close: vi.fn(),
  } satisfies WorkspaceStore
  return {
    store,
    disk,
    parkNextWrite: () => { parkNext = true },
    parkedWrite,
    release: () => release(),
  }
}

async function connect(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const notifications: string[] = []
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number; method?: string }
    if (message.id !== undefined) responses.get(message.id)?.(message)
    else if (message.method) notifications.push(message.method)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId
      responses.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  const hello = await rpc("system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })
  expect(hello.error).toBeUndefined()
  return { rpc, notifications }
}

const workspaceService = {
  inspect: vi.fn(),
  createSessionWorkspace: vi.fn(),
  createSessionWorkspaceFromCheckpoint: vi.fn(async (_path: string, commit: string, sessionId: string) => ({
    path: `/worktrees/${sessionId}`,
    branch: `domovoi/${sessionId}`,
    baseCommit: commit,
  })),
  removeSessionWorkspace: vi.fn(async () => {}),
  checkpoint: vi.fn(),
  restore: vi.fn(),
} satisfies WorkspaceService

function streamingWorkspace() {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const [streaming, source] = snapshot.sessions
  for (const session of [streaming!, source!]) {
    session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
    session.state = "idle"
    delete session.activeTurnId
  }
  streaming!.workspacePath = "/worktrees/session-streaming"
  streaming!.providerThreadId = "thread-streaming"
  source!.workspacePath = "/worktrees/session-source"
  source!.providerThreadId = "thread-source"
  snapshot.thread.push({
    id: "checkpoint-source-fork",
    sessionId: source!.id,
    kind: "checkpoint",
    label: "88888888 · fork point",
    commit: "8".repeat(40),
    createdAt: "2026-08-29T12:00:00.000Z",
  })
  return { snapshot: workspaceSnapshotSchema.parse(snapshot), streaming: streaming!, source: source! }
}

const assistantText = (snapshot: WorkspaceSnapshot, sessionId: string) => snapshot.thread
  .filter((item) => item.sessionId === sessionId && item.kind === "assistant")
  .map((item) => (item.kind === "assistant" ? item.body : ""))
  .join("")

describe("whole-snapshot writes", () => {
  it("keeps text another session streamed while a fork was saving", async () => {
    const { snapshot, streaming, source } = streamingWorkspace()
    const { store, disk, parkNextWrite, parkedWrite, release } = parkingStore(snapshot)
    const listeners = new Set<(event: AgentEvent) => void>()
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agentWith(listeners, ["fork-thread"]) },
      workspaceService,
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const { rpc, notifications } = await connect(daemon, port)
    const sent = await rpc("session.send", { sessionId: streaming.id, prompt: "go", client: "desktop" })
    expect(sent.error).toBeUndefined()

    parkNextWrite()
    const forked = rpc("session.fork", {
      sessionId: source.id,
      checkpointId: "checkpoint-source-fork",
      requestId: "fork-while-streaming",
      runtime: source.runtime,
      client: "desktop",
    })
    await parkedWrite
    notifications.length = 0
    for (const listener of listeners) {
      listener({ type: "text-delta", threadId: "thread-streaming", turnId: "turn-streaming", delta: "streamed during the fork" })
    }
    await waitForDaemon(() => expect(notifications).toContain("workspace.delta"))
    release()
    const fork = await forked
    expect(fork.error).toBeUndefined()

    const live = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(live.sessions.some((session) => session.forkedFrom?.requestId === "fork-while-streaming")).toBe(true)
    expect(assistantText(live, streaming.id)).toContain("streamed during the fork")
    await rpc("session.pause", { sessionId: streaming.id, client: "desktop" })
    const last = disk.at(-1)!
    expect(last.sessions.some((session) => session.forkedFrom?.requestId === "fork-while-streaming")).toBe(true)
  })

  it("lands a provider restart on disk after a write posted before it", async () => {
    const { snapshot, streaming, source } = streamingWorkspace()
    const failed = snapshot.sessions.find((session) => session.id === source.id)!
    failed.state = "failed"
    delete failed.providerThreadId
    const { store, disk, parkNextWrite, parkedWrite, release } = parkingStore(snapshot)
    const listeners = new Set<(event: AgentEvent) => void>()
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agentWith(listeners, ["restarted-thread"]) },
      workspaceService,
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const { rpc } = await connect(daemon, port)

    parkNextWrite()
    const earlier = rpc("session.setRuntime", {
      sessionId: streaming.id,
      client: "desktop",
      runtime: { ...streaming.runtime, reasoning: "high" },
    })
    await parkedWrite
    const restarted = rpc("session.restartProviderThread", { sessionId: source.id, client: "desktop" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    expect((await earlier).error).toBeUndefined()
    expect((await restarted).error).toBeUndefined()

    const last = disk.at(-1)!
    expect(last.sessions.find((session) => session.id === source.id)).toMatchObject({
      state: "idle",
      providerThreadId: "restarted-thread",
    })
  })
  it("keeps a provider restart that was cancelled while its write waited off disk", async () => {
    const { snapshot, streaming, source } = streamingWorkspace()
    const failed = snapshot.sessions.find((session) => session.id === source.id)!
    failed.state = "failed"
    delete failed.providerThreadId
    const { store, disk, parkNextWrite, parkedWrite, release } = parkingStore(snapshot)
    const listeners = new Set<(event: AgentEvent) => void>()
    const agent = agentWith(listeners, ["restarted-thread"])
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agents: { codex: agent },
      workspaceService,
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const { rpc } = await connect(daemon, port)
    const other = await connect(daemon, port)

    parkNextWrite()
    const earlier = rpc("session.setRuntime", {
      sessionId: streaming.id,
      client: "desktop",
      runtime: { ...streaming.runtime, reasoning: "high" },
    })
    await parkedWrite
    const restarted = rpc("session.restartProviderThread", { sessionId: source.id, client: "desktop" })
    await waitForDaemon(() => expect(agent.startThread).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stopped = other.rpc("system.emergencyStop", { client: "desktop" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    expect((await earlier).error).toBeUndefined()
    expect((await restarted).error).toBeDefined()
    expect((await stopped).error).toBeUndefined()

    expect(agent.stopThread).toHaveBeenCalledWith("restarted-thread")
    const restartNotice = (item: WorkspaceSnapshot["thread"][number]) =>
      item.kind === "system" && item.body.startsWith("Provider thread restarted")
    for (const written of disk) {
      expect(written.sessions.find((session) => session.id === source.id)?.providerThreadId).toBeUndefined()
      expect(written.thread.some(restartNotice)).toBe(false)
    }
    const live = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(live.sessions.find((session) => session.id === source.id)?.providerThreadId).toBeUndefined()
    expect(live.thread.some(restartNotice)).toBe(false)
  })
})
