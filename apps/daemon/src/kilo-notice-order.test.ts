import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createEmptyWorkspace, protocolVersion } from "@getdomovoi/protocol"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

type ThreadItem = { sessionId: string; kind: string; body?: string; detail?: string }
type RpcReply = {
  result?: { activeSessionId?: string; sessions?: Array<{ id: string }>; thread?: ThreadItem[] }
  error?: { code: number; message: string; data?: unknown }
}

const kiloNoticeBody = "Kilo will run programs this repository lists, with no approval card."
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fakeAgent(provider: string, model: string, startThread: (cwd: string) => Promise<string>): AgentAdapter {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    connect: async () => {},
    listModels: async () => [{
      provider, id: model, displayName: model, description: "Coding model",
      supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", isDefault: true,
    }],
    startThread: async ({ cwd }: { cwd: string }) => startThread(cwd),
    resumeThread: async () => {},
    stopThread: async () => {},
    interruptTurn: async () => {},
    startTurn: async () => "provider-turn",
    steerTurn: async () => {},
    resolveApproval: () => {},
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: async () => {},
  } as unknown as AgentAdapter
}

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-kilo-notice-"))
  const worktree = async (name: string) => {
    const path = join(scratch, name)
    await mkdir(join(path, ".kilo"), { recursive: true })
    await writeFile(join(path, ".kilo", "mcp.json"), "{}\n")
    return path
  }
  const kiloStarted: string[] = []
  const agents = {
    codex: fakeAgent("codex", "gpt-5.6-sol", async () => "codex-thread"),
    kilo: fakeAgent("kilo", "kilo-model", async (cwd) => {
      kiloStarted.push(cwd)
      await rm(join(cwd, ".kilo"), { recursive: true, force: true })
      return `kilo-thread-${kiloStarted.length}`
    }),
  }
  const workspaceService = {
    inspect: async (path: string) => ({ root: path, name: "repo", branch: "main", head: "a".repeat(40) }),
    createSessionWorkspace: async (_path: string, sessionId: string) => ({
      path: await worktree(sessionId), branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40),
    }),
    createSessionWorkspaceFromCheckpoint: async (_source: string, _commit: string, sessionId: string) => ({
      path: await worktree(sessionId), branch: `domovoi/${sessionId}`, baseCommit: "a".repeat(40),
    }),
    removeSessionWorkspace: async () => {},
    checkpoint: async () => ({ commit: "b".repeat(40), changedFiles: [] }),
    restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
  } as unknown as WorkspaceService
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(join(scratch, "state.sqlite"), createEmptyWorkspace({
      id: `machine-${"7".repeat(32)}`, name: "kilo-notice", platform: process.platform, arch: process.arch,
      version: "0.0.1", connection: "local", reachable: true, providers: [],
    })),
    agents,
    workspaceService,
    agentTimeoutMs: 2_000,
    modelCacheTtlMs: 0,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    errorSink: () => {},
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
    client: "desktop", clientId: "desktop-kilo-notice", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).not.toHaveProperty("error")
  const opened = await rpc("project.open", { path: join(scratch, "repo"), client: "desktop" })
  if (opened.error) await rpc("project.open", { path: join(scratch, "repo"), client: "desktop", confirmation: opened.error.data })
  return { rpc, kiloStarted }
}

const codex = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build", auto: false }
const kilo = { provider: "kilo", model: "kilo-model", reasoning: "medium", permissionMode: "build", auto: false }

function kiloNotices(reply: RpcReply, sessionId: string): ThreadItem[] {
  return (reply.result?.thread ?? []).filter((item) => item.sessionId === sessionId && item.body === kiloNoticeBody)
}

describe("Kilo repository config notice", () => {
  it("is decided before Kilo starts when a session is created on Kilo", async () => {
    const { rpc, kiloStarted } = await fixture()
    const created = await rpc("session.create", { title: "Kilo", runtime: kilo, client: "desktop" })
    expect(created.error).toBeUndefined()
    expect(kiloStarted).toHaveLength(1)
    expect(kiloNotices(created, created.result!.activeSessionId!)).toHaveLength(1)
  })

  it("is decided before Kilo starts when a session is handed off to Kilo", async () => {
    const { rpc, kiloStarted } = await fixture()
    const created = await rpc("session.create", { title: "Codex", runtime: codex, client: "desktop" })
    const sessionId = created.result!.activeSessionId!
    expect(kiloNotices(created, sessionId)).toHaveLength(0)
    const handed = await rpc("session.setRuntime", { sessionId, runtime: kilo, client: "desktop" })
    expect(handed.error).toBeUndefined()
    expect(kiloStarted).toHaveLength(1)
    expect(kiloNotices(handed, sessionId)).toHaveLength(1)
  })

  it("is decided before Kilo starts when a session is forked to Kilo", async () => {
    const { rpc, kiloStarted } = await fixture()
    const created = await rpc("session.create", { title: "Codex", runtime: codex, client: "desktop" })
    const sourceId = created.result!.activeSessionId!
    const checkpoint = (created.result!.thread as Array<ThreadItem & { id: string }>)
      .find((item) => item.sessionId === sourceId && item.kind === "checkpoint")!
    const forked = await rpc("session.fork", {
      sessionId: sourceId, checkpointId: checkpoint.id, requestId: "fork-kilo-notice", runtime: kilo, client: "desktop",
    })
    expect(forked.error).toBeUndefined()
    expect(kiloStarted).toHaveLength(1)
    const fork = forked.result!.sessions!.find((session) => session.id !== sourceId)!
    expect(kiloNotices(forked, fork.id)).toHaveLength(1)
  })
})
