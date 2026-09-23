import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createEmptyWorkspace, protocolVersion } from "@getdomovoi/protocol"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

type RpcReply = { result?: Record<string, unknown> & { queuedSends?: Array<{ id: string; sessionId: string; state: string }> }; error?: { code: number; message: string; data?: unknown } }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-switch-"))
  const listeners = new Set<(event: AgentEvent) => void>()
  let turn = 0
  const agent = {
    connect: async () => {},
    listModels: async () => [{
      provider: "codex", id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Coding model",
      supportedReasoningEfforts: ["none", "medium", "high"], defaultReasoningEffort: "medium", isDefault: true,
    }],
    startThread: async () => "provider-thread-1",
    resumeThread: async () => {},
    stopThread: async () => {},
    interruptTurn: async () => {},
    startTurn: async () => `provider-turn-${++turn}`,
    steerTurn: async () => {},
    resolveApproval: () => {},
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: async () => {},
  } as unknown as AgentAdapter
  const workspaceService = {
    inspect: async (path: string) => ({ root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }),
    createSessionWorkspace: async (_path: string, sessionId: string) => ({
      path: `/worktrees/${sessionId}`, branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40),
    }),
    removeSessionWorkspace: async () => {},
    checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
    restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
  } as unknown as WorkspaceService
  const errors: unknown[] = []
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(join(scratch, "state.sqlite"), createEmptyWorkspace({
      id: `machine-${"9".repeat(32)}`, name: "queued-switch", platform: process.platform, arch: process.arch,
      version: "0.0.1", connection: "local", reachable: true, providers: [],
    })),
    agents: { codex: agent },
    workspaceService,
    agentTimeoutMs: 500,
    modelCacheTtlMs: 0,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    errorSink: (error: unknown) => { errors.push(error) },
  })
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  cleanups.push(async () => {
    socket.terminate()
    await daemon.stop()
    await rm(scratch, { recursive: true, force: true })
  })
  await once(socket, "open")
  let id = 0
  const rpc = (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<RpcReply>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data)) as RpcReply & { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  expect(await rpc("system.hello", {
    client: "desktop", clientId: "desktop-queued-switch", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).not.toHaveProperty("error")
  const completeTurn = (turnId: string) => {
    for (const listener of listeners) {
      listener({ type: "turn-completed", params: { threadId: "provider-thread-1", turnId, status: "completed" } } as AgentEvent)
    }
  }
  const openProject = async (path: string) => {
    const first = await rpc("project.open", { path, client: "desktop" })
    if (!first.error) return first
    return rpc("project.open", { path, client: "desktop", confirmation: first.error.data })
  }
  return { rpc, completeTurn, openProject, errors }
}

const runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build", auto: false }

describe("queued sends across a project switch", () => {
  it("switches projects after a queued send was delivered", async () => {
    const { rpc, completeTurn, openProject, errors } = await fixture()
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    expect(await rpc("session.send", {
      sessionId, prompt: "queued", client: "desktop", delivery: "next-turn-replace",
    })).not.toHaveProperty("error")
    completeTurn("provider-turn-1")
    await expect.poll(async () => (await rpc("workspace.get", {})).result?.queuedSends?.map((queued) => queued.state))
      .toEqual(["delivered"])

    const switched = await openProject("/code/two")
    expect(switched.error).toBeUndefined()
    expect(switched.result).toMatchObject({ project: { path: "/code/two" }, queuedSends: [] })
    expect((await rpc("workspace.get", {})).error).toBeUndefined()
    expect(errors).toEqual([])
  })

  it("keeps a waiting queued send with its project across a switch", async () => {
    const { rpc, openProject, errors } = await fixture()
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    const queued = await rpc("session.send", {
      sessionId, prompt: "queued", client: "desktop", delivery: "next-turn-replace",
    })
    const queueId = queued.result?.queuedSends?.[0]?.id

    const away = await openProject("/code/two")
    expect(away.error).toBeUndefined()
    expect(away.result?.queuedSends).toEqual([])

    const back = await openProject("/code/one")
    expect(back.error).toBeUndefined()
    expect(back.result?.queuedSends).toEqual([expect.objectContaining({ id: queueId, sessionId })])
    expect(errors).toEqual([])
  })
})
