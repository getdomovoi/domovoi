import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let nextId = 0

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

function call(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No test reply to ${method}`)) }, 5_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage) }
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (response.id === id) { cleanup(); resolve(response) }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function client(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const hello = await call(socket, "system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })
  return { socket, hello }
}

function frozenWorkspace() {
  const snapshot = structuredClone(demoWorkspace)
  const [frozen, archiving, ordinary] = snapshot.sessions
  for (const session of [frozen!, archiving!, ordinary!]) {
    session.runtime.provider = "codex"
    session.providerThreadId = `thread-${session.id}`
    delete session.activeTurnId
  }
  frozen!.state = "transferring"
  frozen!.workspacePath = "/worktrees/session-frozen"
  frozen!.baseCommit = "a".repeat(40)
  frozen!.ownershipGeneration = 3
  frozen!.transfer = {
    phase: "transferring",
    transferId: `transfer-${"b".repeat(32)}`,
    targetMachineId: `machine-${"c".repeat(32)}`,
    intentDigest: `sha256:${"d".repeat(64)}`,
    nextGeneration: 4,
    startedAt: "2026-09-03T18:00:00.000Z",
    resumeState: "idle",
    method: "git-bundle",
    requestedBy: { client: "desktop" },
    package: { state: "preparing" },
  }
  archiving!.state = "archiving"
  archiving!.workspacePath = "/worktrees/session-archiving"
  archiving!.archiveRequestedAt = "2026-09-03T18:00:00.000Z"
  ordinary!.state = "idle"
  ordinary!.workspacePath = "/worktrees/session-ordinary"
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

describe("provider disconnect", () => {
  it("leaves a frozen transfer source and an unfinished archive as they were", async () => {
    const snapshot = frozenWorkspace()
    const [frozen, archiving, ordinary] = snapshot.sessions
    const store = {
      load: vi.fn(() => structuredClone(snapshot)),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const listeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => { throw new Error("Provider cleanup timed out") }),
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
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: agent }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const { socket } = await client(daemon, port)
    const before = await call(socket, "workspace.get")
    expect(before.error).toBeUndefined()
    expect(workspaceSnapshotSchema.parse(before.result).sessions.map((session) => session.state))
      .toEqual(["transferring", "archiving", "idle", ...snapshot.sessions.slice(3).map((session) => session.state)])

    await call(socket, "runtime.models", { provider: "codex", client: "desktop" })
    expect(agent.connect).toHaveBeenCalled()
    for (const listener of listeners) {
      listener({ type: "provider-disconnected", reason: "Codex app-server exited with code 1" })
    }

    const { hello } = await client(daemon, port)
    expect(hello.error).toBeUndefined()
    const after = await call(socket, "workspace.get")
    expect(after.error).toBeUndefined()
    const sessions = workspaceSnapshotSchema.parse(after.result).sessions
    expect(sessions.find((session) => session.id === frozen!.id)).toMatchObject({
      state: "transferring",
      providerThreadId: frozen!.providerThreadId,
      transfer: { phase: "transferring" },
    })
    expect(sessions.find((session) => session.id === frozen!.id)?.providerFailure).toBeUndefined()
    expect(sessions.find((session) => session.id === archiving!.id)).toMatchObject({
      state: "archiving",
      archiveRequestedAt: archiving!.archiveRequestedAt,
    })
    expect(sessions.find((session) => session.id === archiving!.id)?.providerFailure).toBeUndefined()
    expect(sessions.find((session) => session.id === ordinary!.id)).toMatchObject({
      state: "failed",
      providerFailure: expect.any(Object),
    })
    for (const saved of store.save.mock.calls) workspaceSnapshotSchema.parse(saved[0])
  })
})
