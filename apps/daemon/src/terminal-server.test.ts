import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex"
import { DomovoiDaemon } from "./server"
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store"
import type { TerminalProcess, TerminalService } from "./terminal"
import type { WorkspaceService } from "./workspace"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
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
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, any>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, any>)
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
    expect(stopped.result.failures[0].message.length).toBeLessThanOrEqual(512)
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
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, any>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, any>)
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
    await vi.waitFor(() => expect(agent.startTurn).toHaveBeenCalledOnce())
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
    await vi.waitFor(() => expect(agent.interruptTurn).toHaveBeenCalledWith(
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
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, any>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, any>)
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
    await vi.waitFor(() => expect(agent.connect).toHaveBeenCalledOnce())
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

  it("fails closed when provider interrupt and reset cannot stop a turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.state = "active"
    session.runtime.provider = "codex"
    session.workspacePath = "/worktrees/failed-emergency"
    session.providerThreadId = "thread-failed-emergency"
    session.activeTurnId = "turn-failed-emergency"
    snapshot.approvals = []
    let listener: ((event: AgentEvent) => void) | undefined
    const never = () => new Promise<void>(() => {})
    const agent = {
      connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(never), startTurn: vi.fn(async () => "new-turn"),
      steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(never),
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
      agentTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      const response = new Promise<Record<string, any>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== requestId) return
          socket.off("message", receive)
          resolve(message as Record<string, any>)
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
    const store = new SqliteWorkspaceStore(statePath, snapshot)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      agent,
      terminalService,
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, any>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, any>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await rpc("system.hello", {
      client: "desktop",
      clientVersion: "0.0.1",
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
        clientVersion: "0.0.1",
        clientId: "tablet-observer",
        authToken: daemon.authToken,
      },
    }))
    await observerHello
    const emergencyNotification = new Promise<Record<string, any>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, any>
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
    await vi.waitFor(() => expect(workspaceService.checkpoint).toHaveBeenCalledOnce())

    const stopped = await rpc("system.emergencyStop", { client: "phone" })
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
    for (const session of active) {
      const current = stopped.result.snapshot.sessions.find(({ id }: { id: string }) => id === session.id)
      expect(current).not.toHaveProperty("activeTurnId")
      expect(processes.get(session.workspacePath!)?.kill).toHaveBeenCalledOnce()
      expect(agent.interruptTurn).toHaveBeenCalledWith(session.providerThreadId, session.activeTurnId)
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
          actor: { kind: "client", client: "desktop", clientId: "desktop-emergency" },
          action: "system.emergencyStop",
          outcome: "succeeded",
        })],
      },
    })

    listener!({
      type: "approval-requested",
      requestId: 99,
      threadId: active[0]!.providerThreadId!,
      command: "pnpm publish",
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
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      terminalService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
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
    await vi.waitFor(() => expect(agent.interruptTurn).toHaveBeenCalledOnce())
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
    await vi.waitFor(() => expect(agent.interruptTurn).toHaveBeenCalledTimes(2))
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

    await expect(rpc("terminal.create", {
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

    await expect(rpc("terminal.input", {
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
    const claiming = rpc("terminal.claim", {
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

    await expect(rpc("terminal.input", {
      terminalId: "terminal-1",
      data: "pnpm test\r",
      client: "tablet",
      clientId: "tablet-client-1",
    })).resolves.toMatchObject({ result: { accepted: true } })
    expect(terminal.write).toHaveBeenCalledWith("pnpm test\r")
    await rpc("terminal.resize", {
      terminalId: "terminal-1",
      cols: 80,
      rows: 24,
      client: "tablet",
      clientId: "tablet-client-1",
    })
    expect(terminal.resize).toHaveBeenCalledWith(80, 24)
    await rpc("terminal.close", {
      terminalId: "terminal-1",
      client: "tablet",
      clientId: "tablet-client-1",
    })
    expect(terminal.kill).toHaveBeenCalledOnce()
    socket.close()
  })
})
