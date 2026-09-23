import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import type { TerminalProcess } from "./terminal.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

type Reply = { result?: Record<string, unknown>; error?: { code: number; message: string } }

async function terminalDaemon(graceMs: number) {
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
    terminalReapGraceMs: graceMs,
    errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const connect = async (clientId: string) => {
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
      client: "desktop", clientVersion: "0.0.1", protocolVersion, clientId, authToken: daemon.authToken,
    })).error).toBeUndefined()
    return { socket, rpc }
  }
  const create = (rpc: (method: string, params: Record<string, unknown>) => Promise<Reply>, clientId: string) =>
    rpc("terminal.create", {
      terminalId: "terminal-reconnect", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId,
    })
  const input = (rpc: (method: string, params: Record<string, unknown>) => Promise<Reply>, data: string, clientId: string) =>
    rpc("terminal.input", { terminalId: "terminal-reconnect", data, client: "desktop", clientId })
  return { terminal, connect, create, input }
}

const pastGrace = (graceMs: number) => new Promise((resolve) => setTimeout(resolve, graceMs * 3))

describe("terminal ownership across a reconnect", () => {
  it("keeps the terminal of a client that reconnects without reopening its pane", async () => {
    const graceMs = 60
    const { terminal, connect, create, input } = await terminalDaemon(graceMs)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    first.socket.close()
    await once(first.socket, "close")

    const second = await connect("desktop-owner")
    await pastGrace(graceMs)
    expect(terminal.kill).not.toHaveBeenCalled()
    expect((await input(second.rpc, "echo still here\r", "desktop-owner")).error).toBeUndefined()
    expect(terminal.write).toHaveBeenCalledWith("echo still here\r")
  })

  it("lets the owner type from its new connection before the old one closes", async () => {
    const graceMs = 60
    const { terminal, connect, create, input } = await terminalDaemon(graceMs)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()

    const second = await connect("desktop-owner")
    expect((await create(second.rpc, "desktop-owner")).result).toMatchObject({ owner: { clientId: "desktop-owner" } })
    expect((await input(second.rpc, "ls\r", "desktop-owner")).error).toBeUndefined()

    first.socket.close()
    await once(first.socket, "close")
    await pastGrace(graceMs)
    expect(terminal.kill).not.toHaveBeenCalled()
    expect((await input(second.rpc, "pwd\r", "desktop-owner")).error).toBeUndefined()
  })

  it("still refuses another client and still reaps an abandoned terminal", async () => {
    const graceMs = 60
    const { terminal, connect, create, input } = await terminalDaemon(graceMs)
    const owner = await connect("desktop-owner")
    expect((await create(owner.rpc, "desktop-owner")).error).toBeUndefined()
    const other = await connect("desktop-other")
    expect((await input(other.rpc, "rm -rf .\r", "desktop-other")).error).toMatchObject({ message: "Terminal is owned by another client" })

    owner.socket.close()
    await once(owner.socket, "close")
    await pastGrace(graceMs)
    expect(terminal.kill).toHaveBeenCalled()
  })
})
