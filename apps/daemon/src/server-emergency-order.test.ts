import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function connect(daemon: DomovoiDaemon, port: number, client: "desktop" | "phone") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const notifications: Array<{ method: string; params: unknown }> = []
  const responses = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number; method?: string; params?: unknown }
    if (message.id !== undefined) responses.get(message.id)?.(message)
    else if (message.method) notifications.push({ method: message.method, params: message.params })
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = ++nextId
      responses.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  expect((await rpc("system.hello", {
    client, clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).error).toBeUndefined()
  return { rpc, notifications }
}

describe("emergency stop", () => {
  it("tells other clients about the stop before the snapshot that shows it", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals = []
    const session = snapshot.sessions[0]!
    session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
    session.state = "idle"
    session.workspacePath = "/worktrees/session-stop"
    session.providerThreadId = "thread-stop"
    delete session.activeTurnId
    const store = {
      load: () => structuredClone(snapshot),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => [{
        provider: "codex" as const, id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Coding model",
        supportedReasoningEfforts: ["none", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "xhigh", isDefault: true,
      }]),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-running"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: agent }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const owner = await connect(daemon, port, "desktop")
    const observer = await connect(daemon, port, "desktop")
    expect((await owner.rpc("session.send", { sessionId: session.id, prompt: "go", client: "desktop" })).error).toBeUndefined()
    await waitForDaemon(() => expect(observer.notifications.some((notification) => (
      notification.method === "workspace.changed"
      && (notification.params as WorkspaceSnapshot).sessions.some((candidate) => candidate.activeTurnId === "turn-running")
    ))).toBe(true))
    observer.notifications.length = 0

    expect((await owner.rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
    await waitForDaemon(() => expect(observer.notifications.map(({ method }) => method)).toContain("system.emergencyStopped"))
    const firstIdle = observer.notifications.findIndex((notification) => (
      notification.method === "workspace.changed"
      && (notification.params as WorkspaceSnapshot).sessions.every((candidate) => candidate.activeTurnId === undefined)
    ))
    const stopped = observer.notifications.findIndex(({ method }) => method === "system.emergencyStopped")
    expect(stopped).toBeGreaterThanOrEqual(0)
    if (firstIdle >= 0) expect(stopped).toBeLessThan(firstIdle)
  })
})
