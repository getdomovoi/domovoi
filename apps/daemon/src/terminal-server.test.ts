import { waitForDaemon } from "./test-wait-for.js"
import WebSocket from "ws"
import { removeScratchDirectories } from "./test-scratch.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  demoWorkspace,
  maximumTerminalReplayCharacters,
  protocolVersion,
  type RpcMethod,
  type RpcResult,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex"
import { DomovoiDaemon } from "./server"
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store"
import type { TerminalProcess, TerminalService } from "./terminal"
import type { WorkspaceService } from "./workspace"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []
type TestRpcResponse<M extends RpcMethod> = Record<string, unknown> & { result: RpcResult<M> }

function deferLiveTurns(snapshot: typeof demoWorkspace): () => void {
  const turns = snapshot.sessions.flatMap((session) => session.activeTurnId
    ? [{ sessionId: session.id, state: session.state, activeTurnId: session.activeTurnId }]
    : [])
  const affected = new Set(turns.map(({ sessionId }) => sessionId))
  const approvals = snapshot.approvals.filter((approval) => affected.has(approval.sessionId))
  for (const turn of turns) {
    const session = snapshot.sessions.find(({ id }) => id === turn.sessionId)!
    session.state = "idle"
    delete session.activeTurnId
  }
  snapshot.approvals = snapshot.approvals.filter((approval) => !affected.has(approval.sessionId))
  return () => {
    for (const turn of turns) {
      const session = snapshot.sessions.find(({ id }) => id === turn.sessionId)!
      session.state = turn.state
      session.activeTurnId = turn.activeTurnId
    }
    snapshot.approvals.push(...approvals)
  }
}

function authenticatedSocket(
  daemon: DomovoiDaemon,
  url: string,
  client: "desktop" | "tablet" = "desktop",
): WebSocket {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  const automaticHelloId = "test-automatic-client-identity"
  const emit = socket.emit.bind(socket)
  const send = socket.send.bind(socket)
  const pending: Array<{ data: unknown; args: unknown[] }> = []
  let identityState: "unsent" | "pending" | "established" = "unsent"

  // Tests using this helper model a normal authenticated client. Send its
  // immutable hello before the first ordinary RPC. Raw sockets still exercise
  // authentication and missing-identity failures directly.
  socket.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "message") {
      try {
        const message = JSON.parse(String(args[0])) as { id?: unknown }
        if (message.id === automaticHelloId) {
          identityState = "established"
          for (const queued of pending.splice(0)) {
            Reflect.apply(send, socket, [queued.data, ...queued.args])
          }
          return true
        }
      } catch {
        // Non-JSON frames still belong to the test that sent them.
      }
    }
    return Reflect.apply(emit, socket, [event, ...args]) as boolean
  }) as typeof socket.emit
  socket.send = ((data: unknown, ...args: unknown[]) => {
    try {
      const request = JSON.parse(String(data)) as { method?: unknown }
      if (request.method === "system.hello") {
        identityState = "established"
      } else if (identityState !== "established") {
        pending.push({ data, args })
        if (identityState === "pending") return
        identityState = "pending"
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: automaticHelloId,
          method: "system.hello",
          params: {
            client,
            clientId: `${client}-terminal-test`,
            clientVersion: "0.0.1",
            protocolVersion,
          },
        }))
        return
      }
    } catch {
      if (identityState !== "established") {
        pending.push({ data, args })
        if (identityState === "pending") return
        identityState = "pending"
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: automaticHelloId,
          method: "system.hello",
          params: {
            client,
            clientId: `${client}-terminal-test`,
            clientVersion: "0.0.1",
            protocolVersion,
          },
        }))
        return
      }
    }
    return Reflect.apply(send, socket, [data, ...args])
  }) as typeof socket.send
  return socket
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("terminal RPC", () => {
  it("returns a bounded outcome when emergency persistence fails after teardown", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/persistence-failure"
    snapshot.approvals = []
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const store = {
      load: () => structuredClone(snapshot),
      save: vi.fn(() => { throw new Error(`persist-${"x".repeat(1_000)}`) }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      terminalService: { spawn: vi.fn(() => terminal) },
      errorSink: vi.fn(),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }
    await rpc("terminal.create", {
      terminalId: "terminal-persistence-failure",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-persistence",
    })

    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped).toMatchObject({
      result: {
        outcomes: { terminalsClosed: 1 },
        failures: [expect.objectContaining({ target: "persistence" })],
      },
    })
    expect(stopped.result.failures[0]!.message.length).toBeLessThanOrEqual(512)
    expect(terminal.kill).toHaveBeenCalledOnce()
    socket.close()
  })

  it("cleans up a provider turn that starts after emergency cancellation", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/late-start"
    session.providerThreadId = "thread-late-start"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.thread = snapshot.thread.filter((item) => item.sessionId !== session.id)
    let resolveStart: ((turnId: string) => void) | undefined
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(() => new Promise<string>((resolve) => { resolveStart = resolve })),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
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
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    const sending = rpc("session.send", {
      sessionId: session.id,
      prompt: "start slowly",
      client: "desktop",
    })
    await waitForDaemon(() => expect(agent.startTurn).toHaveBeenCalledOnce())
    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped).toMatchObject({
      result: {
        outcomes: {
          turnsStopped: 0,
          mutationsCancelled: 1,
          providersReset: 1,
        },
      },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("thread-late-start")

    resolveStart!("turn-started-late")
    await expect(sending).resolves.toMatchObject({
      error: { code: -32603, message: "Operation cancelled by emergency stop" },
    })
    await waitForDaemon(() => expect(agent.interruptTurn).toHaveBeenCalledWith(
      "thread-late-start",
      "turn-started-late",
    ))
    listener!({
      type: "text-delta",
      threadId: "thread-late-start",
      turnId: "turn-started-late",
      delta: "late output",
    })
    listener!({
      type: "approval-requested",
      requestId: 101,
      threadId: "thread-late-start",
      command: "pnpm publish",
    })
    const after = await rpc("workspace.get", {})
    expect(after.result.approvals).toEqual([])
    expect(JSON.stringify(after.result.thread)).not.toMatch(/start slowly|late output/)
    expect(after.result.sessions.find(({ id }: { id: string }) => id === session.id)).not
      .toHaveProperty("activeTurnId")
    socket.close()
  })

  it("does not start a provider turn after emergency stop interrupts slow connection", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/slow-connect"
    session.providerThreadId = "thread-slow-connect"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.thread = snapshot.thread.filter((item) => item.sessionId !== session.id)
    let resolveConnect: (() => void) | undefined
    const agent = {
      connect: vi.fn(() => new Promise<void>((resolve) => { resolveConnect = resolve })),
      listModels: vi.fn(async () => []), startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "must-not-start"), steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}), resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
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
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    const sending = rpc("session.send", {
      sessionId: session.id,
      prompt: "wait for connection",
      client: "desktop",
    })
    await waitForDaemon(() => expect(agent.connect).toHaveBeenCalledOnce())
    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped).toMatchObject({
      result: { outcomes: { providersReset: 1, mutationsCancelled: 1 } },
    })
    expect(agent.stopThread).toHaveBeenCalledWith("thread-slow-connect")

    resolveConnect!()
    await expect(sending).resolves.toMatchObject({
      error: { code: -32603, message: "Operation cancelled by emergency stop" },
    })
    expect(agent.resumeThread).not.toHaveBeenCalled()
    expect(agent.startTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it("refuses session.send while emergency stop is interrupting the turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/send-during-stop"
    session.providerThreadId = "thread-send-during-stop"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.thread = snapshot.thread.filter((item) => item.sessionId !== session.id)
    let interruptStarted: (() => void) | undefined
    let releaseInterrupt: (() => void) | undefined
    const interruptBegan = new Promise<void>((resolve) => { interruptStarted = resolve })
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "turn-1"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(() => new Promise<void>((resolve) => {
        releaseInterrupt = resolve
        interruptStarted!()
      })),
      resolveApproval: vi.fn(), onEvent: vi.fn(() => () => {}), close: vi.fn(async () => {}),
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
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }
    const sessionOf = (result: RpcResult<"workspace.get">) =>
      result.sessions.find(({ id: sessionId }) => sessionId === session.id)!

    const first = await rpc("session.send", {
      sessionId: session.id,
      prompt: "first prompt",
      client: "desktop",
    })
    expect(sessionOf(first.result)).toMatchObject({ state: "active", activeTurnId: "turn-1" })

    const stopping = rpc("system.emergencyStop", { client: "desktop" })
    await interruptBegan
    const second = await rpc("session.send", {
      sessionId: session.id,
      prompt: "prompt sent during emergency stop",
      client: "desktop",
    })
    expect(second).toMatchObject({
      error: { code: -32602, message: "Emergency stop is in progress" },
    })
    expect(agent.steerTurn).not.toHaveBeenCalled()

    releaseInterrupt!()
    const stopped = await stopping
    expect(stopped.result.outcomes).toMatchObject({ turnsStopped: 1 })
    expect(stopped.result.failures).toEqual([])
    const after = await rpc("workspace.get", {})
    expect(sessionOf(after.result)).toMatchObject({ state: "idle" })
    expect(sessionOf(after.result)).not.toHaveProperty("activeTurnId")
    expect(agent.steerTurn).not.toHaveBeenCalled()
    socket.close()
  })

  it("fails closed when provider interrupt and reset cannot stop a turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/failed-emergency"
    session.providerThreadId = "thread-failed-emergency"
    session.activeTurnId = "turn-failed-emergency"
    snapshot.approvals = []
    const activateTurns = deferLiveTurns(snapshot)
    let listener: ((event: AgentEvent) => void) | undefined
    const never = () => new Promise<void>(() => {})
    let failedThreadStopAttempts = 0
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => [{
        provider: "codex" as const,
        id: session.runtime.model,
        displayName: session.runtime.model,
        description: "Recovery model",
        supportedReasoningEfforts: [session.runtime.reasoning],
        defaultReasoningEffort: session.runtime.reasoning,
        isDefault: true,
      }]),
      startThread: vi.fn()
        .mockResolvedValueOnce("thread-discarded-recovery")
        .mockResolvedValueOnce("thread-recovered-emergency"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async (threadId: string) => {
        if (threadId !== "thread-failed-emergency") return
        failedThreadStopAttempts += 1
        if (failedThreadStopAttempts === 1) throw new Error("   ")
        if (failedThreadStopAttempts === 2) throw new Error("provider still running")
      }),
      startTurn: vi.fn(async () => "new-turn"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(never),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn(async () => ({ commit: "f".repeat(40), changedFiles: [] })),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
      agent,
      workspaceService,
      agentTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    expect(stopped).toMatchObject({
      result: {
        outcomes: {
          turnsStopped: 0,
          providersReset: 0,
        },
        failures: [expect.objectContaining({
          target: "turn",
          targetId: "turn-failed-emergency",
          message: "Provider reset failed",
        })],
        snapshot: {
          sessions: expect.arrayContaining([expect.objectContaining({
            id: session.id,
            state: "failed",
            providerThreadId: "thread-failed-emergency",
          })]),
        },
      },
    })
    await expect(rpc("session.send", {
      sessionId: session.id,
      prompt: "do not revive this thread",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Provider thread requires recovery after emergency stop" },
    })
    listener!({
      type: "approval-requested",
      requestId: 99,
      threadId: "thread-failed-emergency",
      command: "pnpm publish",
    })
    await expect(rpc("workspace.get", {})).resolves.toMatchObject({ result: { approvals: [] } })
    expect(agent.startTurn).not.toHaveBeenCalled()

    await expect(rpc("session.setRuntime", {
      sessionId: session.id,
      runtime: session.runtime,
      client: "desktop",
    })).resolves.toMatchObject({ error: { code: -32603, message: "Internal daemon error" } })
    expect(agent.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: session.workspacePath,
    }))
    expect(agent.stopThread).toHaveBeenCalledWith("thread-discarded-recovery")
    await expect(rpc("session.send", {
      sessionId: session.id,
      prompt: "failed recovery must stay quarantined",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Provider thread requires recovery after emergency stop" },
    })

    const recovered = await rpc("session.setRuntime", {
      sessionId: session.id,
      runtime: session.runtime,
      client: "desktop",
    })
    expect(recovered).toMatchObject({
      result: {
        sessions: expect.arrayContaining([expect.objectContaining({
          id: session.id,
          state: "idle",
          providerThreadId: "thread-recovered-emergency",
        })]),
        thread: expect.arrayContaining([expect.objectContaining({
          sessionId: session.id,
          kind: "system",
          body: expect.stringContaining("Recovered"),
        })]),
      },
    })
    expect(workspaceService.checkpoint).toHaveBeenCalledWith(
      session.workspacePath,
      "before provider recovery",
      expect.any(AbortSignal),
    )
    expect(failedThreadStopAttempts).toBe(3)
    await expect(rpc("session.send", {
      sessionId: session.id,
      prompt: "continue on the replacement thread",
      client: "desktop",
    })).resolves.toHaveProperty("result")
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-recovered-emergency",
    }))
    socket.close()
  })

  it("stops every turn, terminal, and approval through the high-priority emergency path", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.slice(0, 2)
    for (const [index, session] of active.entries()) {
      session.state = "active"
      session.runtime.provider = "codex"
      session.workspacePath = `/worktrees/emergency-${index}`
      session.providerThreadId = `thread-emergency-${index}`
      session.activeTurnId = `turn-emergency-${index}`
    }
    const activeTurnIds = active.map((session) => session.activeTurnId!)
    const checkpointSession = snapshot.sessions[2]!
    checkpointSession.workspacePath = "/worktrees/emergency-checkpoint"
    checkpointSession.runtime.provider = "codex"
    const approvalRules = structuredClone(snapshot.approvalRules)
    snapshot.approvals = [active[0]!, checkpointSession].map((session, index) => ({
      ...snapshot.approvals[0]!,
      id: `approval-emergency-${index}`,
      sessionId: session.id,
      providerRequestId: 70 + index,
    }))
    const activateTurns = deferLiveTurns(snapshot)

    const processes = new Map<string, TerminalProcess>()
    const terminalService = {
      spawn: vi.fn(({ cwd }: { cwd: string }) => {
        const process = {
          process: "bash",
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => ({ dispose: vi.fn() })),
          onExit: vi.fn(() => ({ dispose: vi.fn() })),
        } satisfies TerminalProcess
        processes.set(cwd, process)
        return process
      }),
    } satisfies TerminalService
    let listener: ((event: AgentEvent) => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(),
      createSessionWorkspace: vi.fn(),
      removeSessionWorkspace: vi.fn(),
      checkpoint: vi.fn((_path: string, _label: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })),
      restore: vi.fn(),
    } satisfies WorkspaceService
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-emergency-stop-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const sqliteStore = new SqliteWorkspaceStore(statePath, snapshot)
    const store = {
      auditLog: sqliteStore.auditLog,
      load: () => snapshot,
      save: (next: typeof snapshot) => sqliteStore.save(next),
      close: () => sqliteStore.close(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agent,
      terminalService,
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<TestRpcResponse<M>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as TestRpcResponse<M>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1", protocolVersion,
      clientId: "desktop-emergency",
      authToken: daemon.authToken,
    })
    const observer = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      observer.once("open", resolve)
      observer.once("error", reject)
    })
    const observerHello = new Promise<void>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== 900) return
        observer.off("message", receive)
        resolve()
      }
      observer.on("message", receive)
    })
    observer.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 900,
      method: "system.hello",
      params: {
        client: "tablet",
        clientVersion: "0.0.1", protocolVersion,
        clientId: "tablet-observer",
        authToken: daemon.authToken,
      },
    }))
    await observerHello
    const emergencyNotification = new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.method !== "system.emergencyStopped") return
        observer.off("message", receive)
        resolve(message)
      }
      observer.on("message", receive)
    })
    for (const [index, session] of active.entries()) {
      await rpc("terminal.create", {
        terminalId: `terminal-emergency-${index}`,
        sessionId: session.id,
        cols: 80,
        rows: 24,
        client: "desktop",
        clientId: "desktop-emergency",
      })
    }

    const activeCheckpoint = rpc("checkpoint.create", {
      sessionId: checkpointSession.id,
      label: "blocked checkpoint",
      client: "desktop",
    })
    const queuedCheckpoint = rpc("checkpoint.create", {
      sessionId: checkpointSession.id,
      label: "queued checkpoint",
      client: "desktop",
    })
    await waitForDaemon(() => expect(workspaceService.checkpoint).toHaveBeenCalledOnce())

    const stopped = await rpc("system.emergencyStop", { client: "desktop" })
    await expect(emergencyNotification).resolves.toMatchObject({
      method: "system.emergencyStopped",
      params: {
        stopId: stopped.result.stopId,
        client: "desktop",
        outcomes: stopped.result.outcomes,
      },
    })
    expect(stopped).toMatchObject({
      result: {
        stopId: expect.any(String),
        requestedAt: expect.any(String),
        client: "desktop",
        outcomes: {
          turnsStopped: 2,
          terminalsClosed: 2,
          approvalsDenied: 2,
          mutationsCancelled: 2,
          providersReset: 0,
        },
        failures: [],
        snapshot: {
          approvals: [],
          approvalRules,
          sessions: expect.arrayContaining(active.map((session) => expect.objectContaining({
            id: session.id,
            state: "idle",
          }))),
          thread: expect.arrayContaining(active.map((session) => expect.objectContaining({
            sessionId: session.id,
            kind: "system",
            body: "Emergency stop requested by desktop.",
          }))),
        },
      },
    })
    for (const [index, session] of active.entries()) {
      const current = stopped.result.snapshot.sessions.find(({ id }: { id: string }) => id === session.id)
      expect(current).not.toHaveProperty("activeTurnId")
      expect(processes.get(session.workspacePath!)?.kill).toHaveBeenCalledOnce()
      expect(agent.interruptTurn).toHaveBeenCalledWith(session.providerThreadId, activeTurnIds[index])
    }
    expect(agent.resolveApproval).toHaveBeenCalledWith(70, "deny")
    expect(agent.resolveApproval).toHaveBeenCalledWith(71, "deny")
    await expect(activeCheckpoint).resolves.toMatchObject({
      error: { code: -32603, message: "Operation cancelled by emergency stop" },
    })
    await expect(queuedCheckpoint).resolves.toMatchObject({
      error: { code: -32603, message: "Operation cancelled by emergency stop" },
    })
    await expect(rpc("audit.query", {
      action: "system.emergencyStop",
      limit: 10,
    })).resolves.toMatchObject({
      result: {
        entries: [expect.objectContaining({
          actor: expect.objectContaining({
            kind: "client",
            client: "desktop",
            clientId: "desktop-emergency",
            connectionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          }),
          action: "system.emergencyStop",
          outcome: "succeeded",
        })],
      },
    })

    listener!({
      type: "approval-requested",
      requestId: 99,
      threadId: active[0]!.providerThreadId!,
      command: "pnpm dlx skills add getdomovoi/design-studio",
    })
    const afterLateEvent = await rpc("workspace.get", {})
    expect(afterLateEvent.result.approvals).toEqual([])

    const repeated = await rpc("system.emergencyStop", { client: "desktop" })
    expect(repeated.result.outcomes).toEqual({
      turnsStopped: 0,
      terminalsClosed: 0,
      approvalsDenied: 0,
      mutationsCancelled: 0,
      providersReset: 0,
    })
    observer.close()
    socket.close()
    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    const reopened = new SqliteWorkspaceStore(statePath, snapshot)
    const durable = reopened.load()
    expect(durable.project).toEqual(snapshot.project)
    expect(durable.approvalRules).toEqual(approvalRules)
    expect(durable.sessions.map(({ id, runtime, workspacePath }) => ({ id, runtime, workspacePath })))
      .toEqual(snapshot.sessions.map(({ id, runtime, workspacePath }) => ({ id, runtime, workspacePath })))
    expect(durable.thread).toEqual(expect.arrayContaining(active.map((session) =>
      expect.objectContaining({
        sessionId: session.id,
        body: "Emergency stop requested by desktop.",
        detail: expect.stringContaining(stopped.result.stopId),
      }),
    )))
    expect(JSON.stringify(durable.thread)).toContain("2 turns stopped")
    expect(JSON.stringify(durable.thread)).toContain("0 providers reset")
    reopened.close()
  })

  it("redacts a secret out of terminal output and out of the replay it hands a client", async () => {
    const dataListeners = new Set<(data: string) => void>()
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-redaction"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }

    await rpc("terminal.create", {
      terminalId: "terminal-secret",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-secret",
    })

    const collect = (): Promise<Record<string, unknown>> => new Promise((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { method?: string }
        if (message.method !== "terminal.output") return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })

    // The secret arrives split across two reads, which is how a pty delivers
    // anything long enough to matter.
    const streamed = collect()
    for (const listener of dataListeners) listener("export API_KEY=sk-live-")
    for (const listener of dataListeners) listener("abcdef123456\r\n")

    const output = await streamed
    expect(JSON.stringify(output)).not.toContain("sk-live-")
    expect(JSON.stringify(output)).not.toContain("abcdef123456")
    expect(JSON.stringify(output)).toContain("[REDACTED]")

    // A prompt carries no newline, and a terminal that withholds it looks dead.
    const prompted = collect()
    for (const listener of dataListeners) listener("me@host:~$ ")
    expect(JSON.stringify(await prompted)).toContain("me@host:~$ ")

    const attached = await rpc("terminal.create", {
      terminalId: "terminal-secret",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-secret",
    })
    expect(JSON.stringify(attached)).not.toContain("abcdef123456")
    expect(attached).toMatchObject({ result: { buffer: expect.stringContaining("[REDACTED]") } })

    // A short read followed straight away by an exit must still reach the
    // client: redaction holding a tail is not a reason to lose output.
    const closing = new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { method?: string; params?: { data?: string } }
        if (message.method !== "terminal.output" || !message.params?.data?.includes("bye")) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })
    for (const listener of dataListeners) listener("bye")
    await rpc("terminal.close", {
      terminalId: "terminal-secret",
      client: "desktop",
      clientId: "desktop-secret",
    })
    expect(JSON.stringify(await closing)).toContain("bye")

    await rpc("terminal.create", {
      terminalId: "terminal-secret",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-secret",
    })


    socket.close()
  })

  it("hands a reattaching client the last replay window of everything the terminal printed", async () => {
    const dataListeners = new Set<(data: string) => void>()
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-replay"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      return response
    }
    const create = {
      terminalId: "terminal-replay",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-replay",
    }
    await rpc("terminal.create", create)

    // Every read is a distinct line, so a replay that dropped, reordered or
    // duplicated one read would differ from the tail of the whole stream.
    const reads: string[] = []
    for (let index = 0; index < 640; index += 1) reads.push(`${`${index}:`.padEnd(511, "x")}\n`)
    const everything = reads.join("")
    expect(everything.length).toBeGreaterThan(maximumTerminalReplayCharacters)
    for (const read of reads) for (const listener of dataListeners) listener(read)

    const attached = await rpc("terminal.create", create) as TestRpcResponse<"terminal.create">
    expect(attached.result.buffer).toHaveLength(maximumTerminalReplayCharacters)
    expect(attached.result.buffer).toBe(everything.slice(-maximumTerminalReplayCharacters))

    socket.close()
  })

  it("refuses terminal input from a connection that only claims the owner's identity", async () => {
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-ownership"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
    })
    running.push(daemon)
    const address = await daemon.start()

    const open = async () => {
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      let id = 0
      const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
        const requestId = ++id
        const response = new Promise<TestRpcResponse<M>>((resolve) => {
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as { id?: number }
            if (message.id !== requestId) return
            socket.off("message", receive)
            resolve(message as TestRpcResponse<M>)
          }
          socket.on("message", receive)
        })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        return response
      }
      return { socket, rpc }
    }

    const owner = await open()
    const intruder = await open()
    await owner.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1", protocolVersion,
      clientId: "desktop-owner",
    })
    await intruder.rpc("system.hello", {
      client: "tablet",
      clientVersion: "0.0.1", protocolVersion,
      clientId: "tablet-intruder",
    })

    await expect(owner.rpc("terminal.create", {
      terminalId: "terminal-owned",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({ result: { terminalId: "terminal-owned" } })

    // The owner's clientId is broadcast to every client, so a connection that
    // repeats it must still be refused.
    await expect(intruder.rpc("terminal.input", {
      terminalId: "terminal-owned",
      data: "rm -rf /\r",
      client: "tablet",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal is owned by another client" },
    })
    expect(terminal.write).not.toHaveBeenCalled()

    await expect(intruder.rpc("terminal.resize", {
      terminalId: "terminal-owned",
      cols: 200,
      rows: 60,
      client: "tablet",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal is owned by another client" },
    })
    expect(terminal.resize).not.toHaveBeenCalled()

    await expect(intruder.rpc("terminal.close", {
      terminalId: "terminal-owned",
      client: "tablet",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal is owned by another client" },
    })
    expect(terminal.kill).not.toHaveBeenCalled()

    await expect(owner.rpc("terminal.input", {
      terminalId: "terminal-owned",
      data: "pnpm test\r",
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("pnpm test\r")

    owner.socket.close()
    intruder.socket.close()
  })

  it("reaps a terminal whose owner disappears and nothing reclaims it", async () => {
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-reap"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
      terminalReapGraceMs: 150,
    })
    running.push(daemon)
    const address = await daemon.start()
    const open = async () => {
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      let id = 0
      const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
        const requestId = ++id
        const response = new Promise<TestRpcResponse<M>>((resolve) => {
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as { id?: number }
            if (message.id !== requestId) return
            socket.off("message", receive)
            resolve(message as TestRpcResponse<M>)
          }
          socket.on("message", receive)
        })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        return response
      }
      return { socket, rpc }
    }
    const owner = await open()
    const survivor = await open()
    await owner.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "desktop-reap-owner",
    })
    await survivor.rpc("system.hello", {
      client: "tablet",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "tablet-survivor",
    })

    await owner.rpc("terminal.create", {
      terminalId: "terminal-reap",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-reap-owner",
    })
    owner.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(terminal.kill).toHaveBeenCalledOnce()
    await expect(survivor.rpc("terminal.input", {
      terminalId: "terminal-reap",
      data: "still there\r",
      client: "tablet",
      clientId: "tablet-survivor",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal does not exist" },
    })
    survivor.socket.close()
  })

  it("keeps a terminal whose owner reconnects and reclaims it inside the grace window", async () => {
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-reclaim"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
      terminalReapGraceMs: 150,
    })
    running.push(daemon)
    const address = await daemon.start()
    const open = async () => {
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      let id = 0
      const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
        const requestId = ++id
        const response = new Promise<TestRpcResponse<M>>((resolve) => {
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as { id?: number }
            if (message.id !== requestId) return
            socket.off("message", receive)
            resolve(message as TestRpcResponse<M>)
          }
          socket.on("message", receive)
        })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        return response
      }
      return { socket, rpc }
    }
    const owner = await open()
    await owner.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "desktop-reclaim",
    })

    await owner.rpc("terminal.create", {
      terminalId: "terminal-reclaim",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-reclaim",
    })
    owner.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reconnected = await open()
    await reconnected.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "desktop-reclaim",
    })
    await reconnected.rpc("terminal.claim", {
      terminalId: "terminal-reclaim",
      client: "desktop",
      clientId: "desktop-reclaim",
    })
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(terminal.kill).not.toHaveBeenCalled()
    await expect(reconnected.rpc("terminal.input", {
      terminalId: "terminal-reclaim",
      data: "reclaimed\r",
      client: "desktop",
      clientId: "desktop-reclaim",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("reclaimed\r")
    reconnected.socket.close()
  })

  it("returns a terminal to its owner when the owner reconnects", async () => {
    const terminal = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-reconnect"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => structuredClone(snapshot), save: vi.fn(), close: vi.fn() },
      terminalService: { spawn: vi.fn(() => terminal) },
    })
    running.push(daemon)
    const address = await daemon.start()

    const open = async () => {
      const socket = authenticatedSocket(daemon, `ws://${address.host}:${address.port}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      let id = 0
      const rpc = <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
        const requestId = ++id
        const response = new Promise<TestRpcResponse<M>>((resolve) => {
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as { id?: number }
            if (message.id !== requestId) return
            socket.off("message", receive)
            resolve(message as TestRpcResponse<M>)
          }
          socket.on("message", receive)
        })
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        return response
      }
      return { socket, rpc }
    }

    const owner = await open()
    await owner.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "desktop-owner",
    })
    await expect(owner.rpc("terminal.create", {
      terminalId: "terminal-reconnect",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({ result: { terminalId: "terminal-reconnect" } })

    const watcher = await open()
    const ownership: unknown[] = []
    watcher.socket.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { method?: unknown }
      if (message.method === "terminal.ownership") ownership.push(message)
    })
    await watcher.rpc("system.hello", {
      client: "tablet",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "tablet-watcher",
    })

    owner.socket.close()
    await new Promise<void>((resolve) => owner.socket.once("close", resolve))

    const reconnected = await open()
    await reconnected.rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
      protocolVersion,
      clientId: "desktop-owner",
    })
    await expect(reconnected.rpc("terminal.create", {
      terminalId: "terminal-reconnect",
      sessionId: session.id,
      cols: 100,
      rows: 30,
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({
      result: { owner: { client: "desktop", clientId: "desktop-owner" } },
    })

    await expect(reconnected.rpc("terminal.input", {
      terminalId: "terminal-reconnect",
      data: "pnpm test\r",
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("pnpm test\r")

    await expect(reconnected.rpc("terminal.resize", {
      terminalId: "terminal-reconnect",
      cols: 120,
      rows: 40,
      client: "desktop",
      clientId: "desktop-owner",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.resize).toHaveBeenCalledWith(120, 40)
    await waitForDaemon(() => expect(ownership).toContainEqual(expect.objectContaining({
      method: "terminal.ownership",
      params: { terminalId: "terminal-reconnect", owner: { client: "desktop", clientId: "desktop-owner" } },
    })))

    watcher.socket.close()
    reconnected.socket.close()
  })

  it("owns terminal input, resize, output, and shutdown on the daemon", async () => {
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
    const terminal = {
      process: "bash",
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      }),
      onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener)
        return { dispose: () => exitListeners.delete(listener) }
      }),
    } satisfies TerminalProcess
    const terminalService = {
      spawn: vi.fn(() => terminal),
    } satisfies TerminalService
    let releaseInterrupt: (() => void) | undefined
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(() => new Promise<void>((resolve) => {
        releaseInterrupt = resolve
      })),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/billing"
    session.state = "active"
    session.runtime.provider = "codex"
    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-billing"
    const activateTurns = deferLiveTurns(snapshot)
    const daemon = new DomovoiDaemon({
      port: 0,
      store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
      agent,
      terminalService,
    })
    running.push(daemon)
    const address = await daemon.start()
    activateTurns()
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

    const tabletSocket = authenticatedSocket(
      daemon,
      `ws://${address.host}:${address.port}/rpc`,
      "tablet",
    )
    await new Promise<void>((resolve, reject) => {
      tabletSocket.once("open", resolve)
      tabletSocket.once("error", reject)
    })
    let tabletRequestId = 0
    const tabletRpc = (method: string, params: Record<string, unknown>) => {
      const id = ++tabletRequestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          tabletSocket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        tabletSocket.on("message", receive)
      })
      tabletSocket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }


    const created = await rpc("terminal.create", {
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 32,
      client: "desktop",
      clientId: "desktop-client-1",
    })
    expect(created).toMatchObject({
      result: {
        terminalId: "terminal-1",
        sessionId: "session-billing",
        shell: "bash",
        cwd: "/worktrees/billing",
        buffer: "",
        owner: { client: "desktop", clientId: "desktop-client-1" },
      },
    })
    expect(terminalService.spawn).toHaveBeenCalledWith({
      cwd: "/worktrees/billing",
      cols: 120,
      rows: 32,
    })

    const pausing = rpc("session.pause", {
      sessionId: "session-billing",
      client: "desktop",
    })
    await waitForDaemon(() => expect(agent.interruptTurn).toHaveBeenCalledOnce())
    const terminalInput = rpc("terminal.input", {
      terminalId: "terminal-1",
      data: "responsive\r",
      client: "desktop",
      clientId: "desktop-client-1",
    })
    const responsiveness = await Promise.race([
      terminalInput.then(() => "responsive" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    releaseInterrupt!()
    await Promise.all([pausing, terminalInput])
    expect(responsiveness).toBe("responsive")
    expect(terminal.write).toHaveBeenCalledWith("responsive\r")
    terminal.write.mockClear()

    await rpc("session.send", {
      sessionId: "session-billing",
      prompt: "Start another turn",
      client: "desktop",
    })
    const secondPause = rpc("session.pause", {
      sessionId: "session-billing",
      client: "desktop",
    })
    await waitForDaemon(() => expect(agent.interruptTurn).toHaveBeenCalledTimes(2))
    const secondCreated = rpc("terminal.create", {
      terminalId: "terminal-2",
      sessionId: "session-billing",
      cols: 100,
      rows: 28,
      client: "desktop",
      clientId: "desktop-client-1",
    })
    const secondInput = rpc("terminal.input", {
      terminalId: "terminal-2",
      data: "after-create\r",
      client: "desktop",
      clientId: "desktop-client-1",
    })
    const creationOrdering = await Promise.race([
      secondInput.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ])
    releaseInterrupt!()
    await expect(secondPause).resolves.toHaveProperty("result")
    await expect(secondCreated).resolves.toHaveProperty("result.terminalId", "terminal-2")
    const secondInputResult = await secondInput
    expect(creationOrdering).toBe("settled")
    expect(secondInputResult).toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("after-create\r")
    terminal.write.mockClear()

    await rpc("workspace.get", {})
    const output = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })
    for (const listener of dataListeners) listener("ready\r\n")
    await expect(output).resolves.toMatchObject({
      method: "terminal.output",
      params: { terminalId: "terminal-1", data: "ready\r\n" },
    })

    await expect(tabletRpc("terminal.create", {
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 100,
      rows: 28,
      client: "tablet",
      clientId: "tablet-client-1",
    })).resolves.toMatchObject({
      result: {
        terminalId: "terminal-1",
        cols: 120,
        rows: 32,
        buffer: "ready\r\n",
        owner: { client: "desktop", clientId: "desktop-client-1" },
      },
    })
    expect(terminalService.spawn).toHaveBeenCalledTimes(2)
    expect(terminal.resize).not.toHaveBeenCalled()

    await expect(tabletRpc("terminal.input", {
      terminalId: "terminal-1",
      data: "pnpm test\r",
      client: "tablet",
      clientId: "tablet-client-1",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal is owned by another client" },
    })
    expect(terminal.write).not.toHaveBeenCalled()

    const ownership = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    })
    const claiming = tabletRpc("terminal.claim", {
      terminalId: "terminal-1",
      client: "tablet",
      clientId: "tablet-client-1",
    })
    await expect(ownership).resolves.toMatchObject({
      method: "terminal.ownership",
      params: {
        terminalId: "terminal-1",
        owner: { client: "tablet", clientId: "tablet-client-1" },
      },
    })
    await expect(claiming).resolves.toMatchObject({
      result: {
        terminalId: "terminal-1",
        owner: { client: "tablet", clientId: "tablet-client-1" },
      },
    })

    await expect(rpc("terminal.close", {
      terminalId: "terminal-1",
      client: "desktop",
      clientId: "desktop-client-1",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Terminal is owned by another client" },
    })
    expect(terminal.kill).not.toHaveBeenCalled()

    await expect(tabletRpc("terminal.input", {
      terminalId: "terminal-1",
      data: "pnpm test\r",
      client: "tablet",
      clientId: "tablet-client-1",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("pnpm test\r")
    await tabletRpc("terminal.resize", {
      terminalId: "terminal-1",
      cols: 80,
      rows: 24,
      client: "tablet",
      clientId: "tablet-client-1",
    })
    expect(terminal.resize).toHaveBeenCalledWith(80, 24)
    await tabletRpc("terminal.close", {
      terminalId: "terminal-1",
      client: "tablet",
      clientId: "tablet-client-1",
    })
    expect(terminal.kill).toHaveBeenCalledOnce()
    socket.close()
  })
})
