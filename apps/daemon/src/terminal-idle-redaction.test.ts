import { once } from "node:events"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

// The daemon releases held terminal output on a short idle beat so a prompt
// with no newline shows. A value typed after its name was released there must
// still be redacted: live, and in the record a rejoining client is handed.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

describe("terminal redaction across an idle beat", () => {
  it("never shows a value typed after its name was released, live or on rejoin", async () => {
    let print: (data: string) => void = () => {}
    const process = {
      process: "zsh",
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        print = listener
        return { dispose: vi.fn() }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    }
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.workspacePath = "/worktrees/idle-redaction"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      terminalService: { spawn: vi.fn(() => process) },
    })
    daemons.push(daemon)
    await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.address!.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    const live: string[] = []
    const replies = new Map<number, (message: Record<string, unknown>) => void>()
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: unknown, method?: unknown, params?: { data?: string } }
      if (typeof message.id === "number") replies.get(message.id)?.(message as Record<string, unknown>)
      else if (message.method === "terminal.output" && message.params?.data) live.push(message.params.data)
    })
    let id = 0
    const call = (method: string, params: Record<string, unknown>) => {
      const requestId = ++id
      return new Promise<Record<string, unknown>>((resolve) => {
        replies.set(requestId, resolve)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      })
    }
    expect(await call("system.hello", { client: "desktop", clientId: "desktop-idle", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
    const create = { terminalId: "terminal-idle", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-idle" }
    expect(await call("terminal.create", create)).not.toHaveProperty("error")

    for (const [name, value] of [["export API_KEY=", "hunter2-live-value"], ["Password: ", "correct-horse-staple"]] as const) {
      print(name)
      await waitForDaemon(() => expect(live.join("")).toContain(name))
      await new Promise((resolve) => setTimeout(resolve, 60))
      print(`${value}\r\n`)
      await waitForDaemon(() => expect(live.join("").lastIndexOf("\r\n")).toBeGreaterThan(live.join("").lastIndexOf(name)))
    }
    print("$ \r\n")
    await waitForDaemon(() => expect(live.join("")).toContain("$ "))
    const rejoined = await call("terminal.create", create)
    for (const text of [live.join(""), (rejoined.result as { buffer: string }).buffer]) {
      expect(text).not.toContain("hunter2-live-value")
      expect(text).not.toContain("correct-horse-staple")
      expect(text).toContain("export API_KEY=[REDACTED]")
      expect(text).toContain("Password: [REDACTED]")
    }
  })
})
