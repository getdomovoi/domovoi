import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex"
import { DomovoiDaemon } from "./server"
import { SqliteWorkspaceStore } from "./store"
import type { TerminalProcess, TerminalService } from "./terminal"

const running: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

describe("terminal RPC", () => {
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
    const agent = {
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
    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions[0]!.workspacePath = "/worktrees/billing"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      terminalService,
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
    expect(terminalService.spawn).toHaveBeenCalledOnce()
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
