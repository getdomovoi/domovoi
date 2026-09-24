import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"

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

function agent() {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => models),
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

describe("snapshot persistence", () => {
  it("shares one pending write among the changes that arrive behind a running one", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals = []
    for (const session of snapshot.sessions) {
      session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build" }
      session.state = "idle"
      delete session.activeTurnId
    }
    const disk: WorkspaceSnapshot[] = []
    let parkNext = false
    let parked = () => {}
    let release = () => {}
    const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
    const store = {
      load: () => structuredClone(snapshot),
      save: vi.fn(),
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
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: agent() }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
    sockets.push(socket)
    await once(socket, "open")
    const responses = new Map<number, (message: { error?: unknown }) => void>()
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; error?: unknown }
      if (message.id !== undefined) responses.get(message.id)?.(message)
    })
    let nextId = 0
    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<{ error?: unknown }>((resolve) => {
        const id = ++nextId
        responses.set(id, resolve)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
    expect((await rpc("system.hello", {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).error).toBeUndefined()
    const reason = (sessionId: string) => rpc("session.setRuntime", {
      sessionId,
      client: "desktop",
      runtime: { ...snapshot.sessions.find((session) => session.id === sessionId)!.runtime, reasoning: "high" },
    })
    const [first, ...rest] = snapshot.sessions.map((session) => session.id)
    const writesBefore = store.saveAsync.mock.calls.length

    parkNext = true
    const running = reason(first!)
    await parkedWrite
    const queued = rest.map((sessionId) => reason(sessionId))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    for (const response of [running, ...queued]) expect((await response).error).toBeUndefined()

    expect(store.saveAsync.mock.calls.length - writesBefore).toBe(2)
    const last = workspaceSnapshotSchema.parse(disk.at(-1))
    expect(last.sessions.map((session) => session.runtime.reasoning)).toEqual(snapshot.sessions.map(() => "high"))
  })
})
