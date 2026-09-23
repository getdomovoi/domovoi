import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import type { WorkspaceService } from "./workspace.js"

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

  it("clears the turn and approvals an archive left on the provider when its cleanup aborted", async () => {
    const snapshot = frozenWorkspace()
    const session = snapshot.sessions[1]!
    session.state = "active"
    delete session.archiveRequestedAt
    const approval = {
      ...structuredClone(demoWorkspace.approvals[0]!),
      id: "approval-archiving",
      sessionId: session.id,
      providerRequestId: 41,
    }
    const store = {
      snapshot,
      load() { return this.snapshot },
      save(next: typeof snapshot) { this.snapshot = structuredClone(next); saved.push(this.snapshot) },
      close: vi.fn(),
    } satisfies WorkspaceStore & { snapshot: typeof snapshot }
    const saved: Array<typeof snapshot> = []
    const listeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => { throw new Error("Archive provider cleanup timed out") }),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => { throw new Error("Archive turn interrupt timed out") }),
      resolveApproval: vi.fn(async () => { throw new Error("provider denial failed") }),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      archiveSessionWorkspace: vi.fn(async () => {}), checkpoint: vi.fn(), restore: vi.fn(),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0, store, agents: { codex: agent }, workspaceService, errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const live = store.snapshot.sessions.find(({ id }) => id === session.id)!
    live.activeTurnId = "turn-archiving"
    store.snapshot.approvals.push(approval)
    const { socket } = await client(daemon, port)

    const archive = await call(socket, "session.archive", { sessionId: session.id, client: "desktop" })
    expect(archive.error).toMatchObject({ code: -32603 })
    const before = workspaceSnapshotSchema.parse((await call(socket, "workspace.get")).result)
    expect(before.sessions.find(({ id }) => id === session.id)).toMatchObject({
      state: "archiving",
      activeTurnId: "turn-archiving",
    })
    expect(before.approvals.map(({ id }) => id)).toEqual([approval.id])

    for (const listener of listeners) {
      listener({ type: "provider-disconnected", reason: "Codex app-server exited with code 1" })
    }

    await client(daemon, port)
    const after = workspaceSnapshotSchema.parse((await call(socket, "workspace.get")).result)
    const archiving = after.sessions.find(({ id }) => id === session.id)
    expect(archiving).toMatchObject({
      state: "archiving",
      providerThreadId: session.providerThreadId,
      archiveRequestedAt: expect.any(String),
    })
    expect(archiving?.activeTurnId).toBeUndefined()
    expect(archiving?.providerFailure).toBeUndefined()
    expect(after.approvals.map(({ id }) => id)).not.toContain(approval.id)
    expect(store.snapshot.approvals.map(({ id }) => id)).not.toContain(approval.id)
    for (const snapshot of saved) workspaceSnapshotSchema.parse(snapshot)
  })
})
