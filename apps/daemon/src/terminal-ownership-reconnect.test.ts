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
  const dataListeners: Array<(data: string) => void> = []
  const terminal = {
    process: "bash",
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      dataListeners.push(listener)
      return { dispose: vi.fn() }
    }),
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
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Reply & { id?: number; method?: string; params?: Record<string, unknown> }
      if (message.id !== undefined) responses.get(message.id)?.(message)
      else if (message.method?.startsWith("terminal.")) notifications.push({ method: message.method, params: message.params ?? {} })
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
    return { socket, rpc, notifications }
  }
  const create = (rpc: (method: string, params: Record<string, unknown>) => Promise<Reply>, clientId: string) =>
    rpc("terminal.create", {
      terminalId: "terminal-reconnect", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId,
    })
  const input = (rpc: (method: string, params: Record<string, unknown>) => Promise<Reply>, data: string, clientId: string) =>
    rpc("terminal.input", { terminalId: "terminal-reconnect", data, client: "desktop", clientId })
  const emit = (data: string) => { for (const listener of dataListeners) listener(data) }
  return { terminal, connect, create, input, emit }
}

const outputTo = (notifications: Array<{ method: string; params: Record<string, unknown> }>) =>
  notifications.filter(({ method }) => method === "terminal.output").map(({ params }) => params.data).join("")

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

  it("sends output to a connection that took the terminal back at hello", async () => {
    const graceMs = 60
    const { connect, create, emit } = await terminalDaemon(graceMs)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const other = await connect("desktop-other")
    first.socket.close()
    await once(first.socket, "close")

    const second = await connect("desktop-owner")
    emit("after the reconnect\n")
    await vi.waitFor(() => expect(outputTo(second.notifications)).toContain("after the reconnect"), { timeout: 2_000 })
    expect(second.notifications.some(({ method }) => method === "terminal.ownership")).toBe(true)
    expect(other.notifications).toEqual([])
  })

  it("sends output to the connection a closing owner hands the terminal to", async () => {
    const graceMs = 60
    const { connect, create, emit } = await terminalDaemon(graceMs)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const second = await connect("desktop-owner")
    first.socket.close()
    await once(first.socket, "close")

    emit("after the handoff\n")
    await vi.waitFor(() => expect(outputTo(second.notifications)).toContain("after the handoff"), { timeout: 2_000 })
  })

  it("hands a reopened pane on the owner's new connection each line once, in the record or live", async () => {
    const { connect, create, emit } = await terminalDaemon(60)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    for (let round = 0; round < 5; round += 1) {
      const next = await connect("desktop-owner")
      // Printed and still waiting in the output batch when the pane reopens.
      emit(`line-${round}\r\n`)
      const reopened = await create(next.rpc, "desktop-owner")
      emit(`after-${round}\r\n`)
      await vi.waitFor(() => expect(outputTo(next.notifications)).toContain(`after-${round}`), { timeout: 2_000 })
      const seen = `${String(reopened.result?.buffer)}${outputTo(next.notifications)}`
      expect(seen.split(`line-${round}\r\n`).length - 1, `round ${round}`).toBe(1)
      expect(seen.split(`after-${round}\r\n`).length - 1, `round ${round}`).toBe(1)
    }
  })

  it("sends output to a connection of the owner that types before reopening its pane", async () => {
    const graceMs = 60
    const { connect, create, input, emit } = await terminalDaemon(graceMs)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const second = await connect("desktop-owner")
    expect((await input(second.rpc, "ls\r", "desktop-owner")).error).toBeUndefined()

    emit("typed from the second connection\n")
    await vi.waitFor(() => expect(outputTo(second.notifications)).toContain("typed from the second connection"), { timeout: 2_000 })
  })
})

// A connection that reuses the owner's client id holds the shell the way a
// claim would, and says so the way a claim does.
describe("an ownership move by the owner's client id", () => {
  const ownershipNotices = (notifications: Array<{ method: string; params: Record<string, unknown> }>) =>
    notifications.filter(({ method, params }) => method === "terminal.ownership" && params.terminalId === "terminal-reconnect")

  it("tells the first connection and every watcher when a second connection types", async () => {
    const { connect, create, input } = await terminalDaemon(60)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const watcher = await connect("desktop-watcher")
    expect((await watcher.rpc("terminal.watch", { terminalId: "terminal-reconnect" })).error).toBeUndefined()
    const second = await connect("desktop-owner")
    expect(ownershipNotices(first.notifications)).toHaveLength(0)
    expect(ownershipNotices(watcher.notifications)).toHaveLength(0)

    expect((await input(second.rpc, "ls\r", "desktop-owner")).error).toBeUndefined()
    await vi.waitFor(() => {
      expect(ownershipNotices(first.notifications)).toHaveLength(1)
      expect(ownershipNotices(watcher.notifications)).toHaveLength(1)
    }, { timeout: 2_000 })
    expect(ownershipNotices(first.notifications)[0]!.params).toMatchObject({ owner: { client: "desktop", clientId: "desktop-owner" } })

    // Typing again from the connection that now holds it is not a move.
    expect((await input(second.rpc, "pwd\r", "desktop-owner")).error).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ownershipNotices(first.notifications)).toHaveLength(1)
  })

  it("still refuses another client id typing without a claim, and moves nothing", async () => {
    const { connect, create, input, terminal } = await terminalDaemon(60)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const other = await connect("desktop-other")
    expect((await input(other.rpc, "rm -rf .\r", "desktop-other")).error).toMatchObject({ message: "Terminal is owned by another client" })
    expect(terminal.write).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ownershipNotices(first.notifications)).toHaveLength(0)
    expect((await input(first.rpc, "ls\r", "desktop-owner")).error).toBeUndefined()
  })

  it("tells the audience when a closing owner hands the shell to its other connection", async () => {
    const { connect, create } = await terminalDaemon(60)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const watcher = await connect("desktop-watcher")
    expect((await watcher.rpc("terminal.watch", { terminalId: "terminal-reconnect" })).error).toBeUndefined()
    const second = await connect("desktop-owner")

    first.socket.close()
    await once(first.socket, "close")
    await vi.waitFor(() => {
      expect(ownershipNotices(watcher.notifications)).toHaveLength(1)
      expect(ownershipNotices(second.notifications)).toHaveLength(1)
    }, { timeout: 2_000 })
  })

  it("tells the audience once when the owner's reconnect takes the shell back at hello", async () => {
    const { connect, create } = await terminalDaemon(2_000)
    const first = await connect("desktop-owner")
    expect((await create(first.rpc, "desktop-owner")).error).toBeUndefined()
    const watcher = await connect("desktop-watcher")
    expect((await watcher.rpc("terminal.watch", { terminalId: "terminal-reconnect" })).error).toBeUndefined()
    first.socket.close()
    await once(first.socket, "close")

    const second = await connect("desktop-owner")
    await vi.waitFor(() => {
      expect(ownershipNotices(watcher.notifications)).toHaveLength(1)
      expect(ownershipNotices(second.notifications)).toHaveLength(1)
    }, { timeout: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ownershipNotices(watcher.notifications)).toHaveLength(1)
  })
})
