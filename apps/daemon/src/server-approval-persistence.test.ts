import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  daemonPersistenceUnavailableErrorCode,
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

function pendingApproval(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "waiting"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  snapshot.approvals = [{ ...demoWorkspace.approvals[0]!, risk: "normal", providerRequestId: 41 }]
  return workspaceSnapshotSchema.parse(snapshot)
}

function agent() {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
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
}

async function connect(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
      const id = ++nextId
      responses.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  const hello = await rpc("system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })
  expect(hello.error).toBeUndefined()
  return rpc
}

describe("approval decisions", () => {
  it("answers the agent only after the decision is saved", async () => {
    const provider = agent()
    let failNext = true
    let parkNext = false
    let parked = () => {}
    let release = () => {}
    const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {
        if (failNext) {
          failNext = false
          throw new Error("database is locked")
        }
        if (parkNext) {
          parkNext = false
          await new Promise<void>((resolve) => {
            release = resolve
            parked()
          })
        }
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const decision = { approvalId: "approval-migrate", decision: "always-project", client: "desktop" }

    const refused = await rpc("approval.resolve", decision)
    expect(refused.error).toMatchObject({ code: daemonPersistenceUnavailableErrorCode })
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    const unchanged = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(unchanged.approvals.map((approval) => approval.id)).toEqual(["approval-migrate"])
    expect(unchanged.approvalRules).toEqual([])
    expect(unchanged.thread.some((item) => item.kind === "receipt")).toBe(false)
    expect(unchanged.sessions.find((session) => session.id === "session-billing")?.state).toBe("waiting")

    parkNext = true
    const accepted = rpc("approval.resolve", decision)
    await parkedWrite
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    release()
    expect((await accepted).error).toBeUndefined()
    expect(provider.resolveApproval).toHaveBeenCalledOnce()
    expect(provider.resolveApproval).toHaveBeenCalledWith(41, "allow-once")
    const decided = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(decided.approvals).toEqual([])
    expect(decided.approvalRules).toEqual([expect.objectContaining({ status: "active", command: "pnpm prisma migrate deploy" })])
    expect(decided.sessions.find((session) => session.id === "session-billing")?.state).toBe("active")
  })
})
