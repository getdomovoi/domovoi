import { once } from "node:events"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { waitForDaemon } from "./test-wait-for.js"

// Terminals are a desktop and web surface, and the pairing card tells a phone
// that terminal output is not on it. What a terminal prints goes to the
// connections that opened or claimed it, and to no phone or tablet credential.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

let nextId = 1

type Connection = {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  notifications: Array<{ method: string; params: unknown }>
}

async function connect(daemon: DomovoiDaemon): Promise<Connection> {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const notifications: Connection["notifications"] = []
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (typeof message.id === "number") pending.get(message.id)?.(message)
    else if (typeof message.method === "string") notifications.push({ method: message.method, params: message.params })
  })
  return {
    notifications,
    call(method, params) {
      const id = nextId++
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return reply
    },
  }
}

function terminalMethods(connection: Connection): string[] {
  return connection.notifications.map(({ method }) => method).filter((method) => method.startsWith("terminal."))
}

describe("terminal notifications", () => {
  it("reach only the connections that opened or claimed the terminal, never a phone or tablet", async () => {
    let print: (data: string) => void = () => {}
    const process = {
      process: "bash",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        print = listener
        return { dispose: vi.fn() }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/terminal-audience"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      terminalService: { spawn: vi.fn(() => process) },
    })
    daemons.push(daemon)
    await daemon.start()

    const hello = (client: string, clientId: string, authToken: string) =>
      ({ client, clientId, clientVersion: "0.0.1", protocolVersion, authToken })
    const owner = await connect(daemon)
    expect(await owner.call("system.hello", hello("desktop", "desktop-owner", daemon.authToken))).not.toHaveProperty("error")
    const viewer = await connect(daemon)
    expect(await viewer.call("system.hello", hello("web", "web-viewer", daemon.authToken))).not.toHaveProperty("error")
    const bystander = await connect(daemon)
    expect(await bystander.call("system.hello", hello("desktop", "desktop-bystander", daemon.authToken))).not.toHaveProperty("error")

    const handhelds: Connection[] = []
    for (const [targetClient, clientAccess] of [["phone", "full"], ["phone", "watching"], ["tablet", "full"]] as const) {
      const minted = await owner.call("device.pair", { label: `${targetClient} ${clientAccess}`, client: "desktop", targetClient, clientAccess })
      expect(minted).not.toHaveProperty("error")
      const connection = await connect(daemon)
      const token = (minted.result as { token: string }).token
      expect(await connection.call("system.hello", hello(targetClient, `${targetClient}-${clientAccess}`, token))).not.toHaveProperty("error")
      handhelds.push(connection)
    }

    const create = { terminalId: "terminal-audience", sessionId: session.id, cols: 80, rows: 24 }
    expect(await owner.call("terminal.create", { ...create, client: "desktop", clientId: "desktop-owner" })).not.toHaveProperty("error")
    expect(await viewer.call("terminal.create", { ...create, client: "web", clientId: "web-viewer" })).not.toHaveProperty("error")

    print("typed-line\r\n")
    await waitForDaemon(() => {
      for (const connection of [owner, viewer]) {
        expect(connection.notifications).toContainEqual({
          method: "terminal.output",
          params: { terminalId: "terminal-audience", data: "typed-line\r\n" },
        })
      }
    })
    expect(await viewer.call("terminal.claim", { terminalId: "terminal-audience", client: "web", clientId: "web-viewer" })).not.toHaveProperty("error")
    await waitForDaemon(() => expect(terminalMethods(owner)).toContain("terminal.ownership"))
    expect(await viewer.call("terminal.close", { terminalId: "terminal-audience", client: "web", clientId: "web-viewer" })).not.toHaveProperty("error")
    await waitForDaemon(() => {
      for (const connection of [owner, viewer]) expect(terminalMethods(connection)).toContain("terminal.closed")
    })

    await owner.call("workspace.get", {})
    for (const connection of [bystander, ...handhelds]) {
      await connection.call("workspace.get", {})
      expect(terminalMethods(connection)).toEqual([])
    }
  })
})
