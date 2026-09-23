import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

type Reply = { result?: unknown; error?: { code: number; message: string } }

async function connect(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Reply) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Reply & { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await rpc("system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).error).toBeUndefined()
  return rpc
}

const workspaceService = (inspect: WorkspaceService["inspect"]) => ({
  inspect,
  createSessionWorkspace: vi.fn(),
  removeSessionWorkspace: vi.fn(async () => {}),
  checkpoint: vi.fn(),
  restore: vi.fn(),
}) satisfies WorkspaceService

function agent(overrides: Partial<AgentAdapter> = {}) {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-started"),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } satisfies AgentAdapter
}

function idleSession() {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const session = snapshot.sessions[0]!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol", permissionMode: "build" }
  session.state = "idle"
  session.workspacePath = "/worktrees/session-send"
  session.providerThreadId = "thread-send"
  delete session.activeTurnId
  return { snapshot: workspaceSnapshotSchema.parse(snapshot), sessionId: session.id }
}

describe("failures a person can act on", () => {
  it("answers project.open on a folder that is not a repository with a public message", async () => {
    const errorSink = vi.fn()
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      workspaceService: workspaceService(async () => {
        throw new Error("fatal: not a git repository (or any of the parent directories): /Users/person/private-notes")
      }),
      errorSink,
      agents: {},
    })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const refused = await rpc("project.open", { path: "/Users/person/private-notes", client: "desktop" })
    expect(refused.error).toEqual({ code: -32602, message: "That folder is not a Git repository with at least one commit" })
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "RPC project.open failed",
      detail: expect.stringContaining("not a git repository"),
    }))
  })

  it.each([
    ["connecting", { connect: vi.fn(async () => { throw new Error("401 Unauthorized: login required") }) }, "authentication-expired", "Provider authentication expired"],
    ["resuming", { resumeThread: vi.fn(async () => { throw new Error("ECONNRESET: socket hang up") }) }, "transport", "Provider connection failed"],
    ["starting a turn", { startTurn: vi.fn(async () => { throw new Error("model gpt-5.6-sol not found") }) }, "model-unavailable", "Selected model is unavailable"],
  ] as const)("records a provider failure while %s and says what it was", async (_step, overrides, kind, message) => {
    const { snapshot, sessionId } = idleSession()
    const store = { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: agent(overrides) }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const refused = await rpc("session.send", { sessionId, prompt: "go", client: "desktop" })
    expect(refused.error).toEqual({ code: -32602, message })
    const workspace = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    const session = workspace.sessions.find((candidate) => candidate.id === sessionId)!
    expect(session.providerFailure).toMatchObject({ kind, message })
    expect(session.activeTurnId).toBeUndefined()
  })
})
